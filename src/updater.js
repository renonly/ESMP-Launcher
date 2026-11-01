const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { API_URL: RAW_API_URL, MANAGED_DIRS, PRESERVE_DIRS = [] } = require("./config");
const API_URL = RAW_API_URL.replace(/\/+$/, "");
const API_ORIGIN = new URL(API_URL).origin;
const R2_ORIGIN = "https://pub-0aa8b496587a463a803f53f6b16bfdda.r2.dev";
const PARALLEL = 4, cachePath = d => path.join(d, "manifest.cache.json"), statePath = d => path.join(d, "pack.installed.json");
const readInstalled = d => { try { return JSON.parse(fs.readFileSync(statePath(d), "utf8")); } catch { return null; } };
const isPreserved = rel => PRESERVE_DIRS.some(d => rel === d || rel.startsWith(d + "/"));
async function needsUpdate(rel, f, abs, prevHashes, force) {
  if (!fs.existsSync(abs)) return true;
  if (isPreserved(rel)) {
    if (force) return true;
    const known = prevHashes[rel];
    if (known === undefined) return false;
    return known !== f.sha1 && (await sha1(abs)) !== f.sha1;
  }
  return force || (await sha1(abs)) !== f.sha1;
}
const posix = p => String(p).replace(/\\/g, "/");
const sha1 = p => new Promise(resolve => {
  const h = crypto.createHash("sha1");
  fs.createReadStream(p).on("data", d => h.update(d))
    .on("end", () => resolve(h.digest("hex"))).on("error", () => resolve(null));
});
async function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function resolveFileUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("URL ausente no manifesto.");
  let parsed;
  try { parsed = new URL(rawUrl, API_URL + "/"); }
  catch { throw new Error(`URL inválida no manifesto: ${rawUrl}`); }
  if (parsed.protocol !== "https:") throw new Error(`URL insegura no manifesto: ${rawUrl}`);
  if (parsed.origin !== API_ORIGIN && parsed.origin !== R2_ORIGIN)
    throw new Error(`Host não permitido no manifesto: ${parsed.host}`);
  return parsed.toString();
}

function validate(m) {
  if (!m || typeof m.version !== "string" || !m.version ||
      !(typeof m.minecraft === "string" || typeof m.minecraft?.version === "string") ||
      !m.loader?.version || !Array.isArray(m.files))
    throw new Error("Manifesto do modpack inválido: confira version, minecraft, loader e files.");

  const seen = new Set();
  for (const f of m.files) {
    const rel = posix(f.path || "");
    if (!rel || rel.startsWith("/") || rel.split("/").some(x => !x || x === "." || x === "..") ||
        !/^[a-f0-9]{40}$/i.test(f.sha1 || "") || seen.has(rel))
      throw new Error(`Entrada inválida no manifesto: ${rel || "(sem caminho)"}`);
    f.url = resolveFileUrl(f.url);
    seen.add(rel);
  }
  return m;
}

async function download(url, dest, expected) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Falha ao baixar ${path.basename(dest)} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash("sha1").update(buf).digest("hex") !== expected)
    throw new Error(`Arquivo corrompido: ${path.basename(dest)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

async function loadManifest(dir) {
  let failure;
  try {
    const r = await fetch(`${API_URL}/manifest`, {
      signal: AbortSignal.timeout(10000), cache: "no-store"
    });
    if (r.ok) {
      const m = validate(await r.json());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath(dir), JSON.stringify(m));
      return { manifest: m, offline: false };
    }
    failure = r.status === 404 ? "O pack ainda não foi publicado no servidor." : `A API respondeu HTTP ${r.status}.`;
  } catch (e) {
    failure = e.message?.toLowerCase().includes("manifest") || e.message?.includes("Host não permitido")
      ? e.message : "Não consegui falar com a API do pack. Verifique sua internet.";
  }
  try {
    return { manifest: validate(JSON.parse(fs.readFileSync(cachePath(dir), "utf8"))), offline: true };
  } catch {
    throw new Error(failure);
  }
}

async function info(dir) {
  const { manifest, offline } = await loadManifest(dir);
  const files = [];
  const prevHashes = readInstalled(dir)?.hashes || {};
  for (const f of manifest.files) {
    const rel = posix(f.path);
    const abs = path.join(dir, ...rel.split("/"));
    const exists = fs.existsSync(abs);
    const status = !exists ? "missing" : !(await needsUpdate(rel, f, abs, prevHashes, false)) ? "ok" : "outdated";
    files.push({ path: f.path, size: f.size || 0, installed: status === "ok", status });
  }
  const pending = files.filter(f => f.status !== "ok");
  const installed = readInstalled(dir);
  return {
    version: manifest.version,
    installedVersion: installed?.version || null,
    minecraft: typeof manifest.minecraft === "string" ? manifest.minecraft : manifest.minecraft.version,
    loader: manifest.loader,
    offline,
    updateAvailable: !offline && pending.length > 0,
    pendingCount: pending.length,
    pendingSize: pending.reduce((a, f) => a + f.size, 0),
    files
  };
}

async function sync(dir, onProgress = () => {}, { force = false } = {}) {
  onProgress({ stage: "Verificando o pack", done: 0, total: 0 });
  const { manifest, offline } = await loadManifest(dir);
  if (offline) {
    onProgress({ stage: "Sem conexão com a API, usando o pack já instalado", done: 1, total: 1 });
    return manifest;
  }

  const wanted = new Map(manifest.files.map(f => [posix(f.path), f]));
  const root = path.resolve(dir), todo = [];
  const prevHashes = readInstalled(root)?.hashes || {};
  const hashes = {};
  for (const [rel, f] of wanted) {
    const abs = path.resolve(root, ...rel.split("/"));
    if (!abs.startsWith(root + path.sep)) throw new Error("Caminho inválido no manifesto.");
    if (await needsUpdate(rel, f, abs, prevHashes, force)) todo.push({ f, abs });
    if (isPreserved(rel)) hashes[rel] = f.sha1;
  }

  let done = 0, next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { f, abs } = todo[next++];
      onProgress({ stage: "Atualizando pack", done, total: todo.length, file: f.path });
      await download(f.url, abs, f.sha1);
      done++;
      onProgress({ stage: "Atualizando pack", done, total: todo.length, file: f.path });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));

  for (const d of MANAGED_DIRS) {
    for (const abs of await walk(path.join(root, d))) {
      const rel = posix(path.relative(root, abs));
      if (!wanted.has(rel)) fs.unlinkSync(abs);
    }
  }
  try { fs.writeFileSync(statePath(root), JSON.stringify({ version: manifest.version, at: Date.now(), hashes })); } catch {}
  onProgress({ stage: todo.length ? "Pack atualizado" : "Pack já está na versão mais recente", done: todo.length, total: todo.length });
  return manifest;
}

const isInstalled = d => !!readInstalled(d) && fs.existsSync(path.join(d, "mods"));
module.exports = { sync, info, isInstalled };
