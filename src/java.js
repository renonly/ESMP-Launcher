const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { app } = require("electron");

// Java baixado pelo próprio launcher (Eclipse Temurin JRE, via API da Adoptium).
// Fica em <userData>/runtime/java-<versão>, sem mexer no Java do sistema.

const HEADERS = { "User-Agent": "ESMP-Launcher", Accept: "*/*" };
const why = (e) => {
  const c = e?.cause;
  return [e?.message, c?.code, c?.message].filter(Boolean).join(" / ") || String(e);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runtimeDir = () => path.join(app.getPath("userData"), "runtime");
const exe = process.platform === "win32" ? "java.exe" : "java";
const homeDir = (major) => path.join(runtimeDir(), `java-${major}`);

function managedPath(major) {
  const p = path.join(homeDir(major), "bin", exe);
  return fs.existsSync(p) ? p : null;
}

function platformInfo() {
  const os = { win32: "windows", darwin: "mac", linux: "linux" }[process.platform];
  let arch = { x64: "x64", arm64: "aarch64" }[process.arch];
  // Windows ARM roda x64 por emulação, e o Temurin 17 não tem build ARM nativo.
  if (os === "windows" && arch === "aarch64") arch = "x64";
  if (!os || !arch) throw new Error(`Sistema não suportado para baixar o Java (${process.platform}/${process.arch}). Instale o Java manualmente.`);
  return { os, arch };
}

async function getPackage(major, log) {
  const { os, arch } = platformInfo();
  const direct = {
    link: `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`,
    name: `temurin-jre-${major}`, checksum: null, size: 0,
  };
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?image_type=jre&os=${os}&architecture=${arch}&vendor=eclipse`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const pkg = (Array.isArray(list) ? list : []).map((x) => x?.binary).find((b) => b?.image_type === "jre" && b?.package?.link)?.package;
    if (!pkg) throw new Error("resposta sem pacote JRE");
    return pkg; // { link, name, checksum (sha256), size }
  } catch (e) {
    log(`[java] API de metadados falhou (${why(e)}). Usando o link direto.`);
    return direct;
  }
}

async function download(url, dest, sizeHint, onProgress) {
  let res;
  try { res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(15 * 60 * 1000) }); }
  catch (e) { throw new Error(`Falha ao baixar o Java: ${why(e)}`); }
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar o Java (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || sizeHint || 0;
  const out = fs.createWriteStream(dest);
  const hash = crypto.createHash("sha256");
  let done = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      done += chunk.length;
      const now = Date.now();
      if (now - last > 100) { last = now; onProgress(done, total); }
    }
    onProgress(done, total);
  } catch (e) {
    throw new Error(`A conexão caiu durante o download do Java: ${why(e)}`);
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest("hex");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || `código ${c}`))));
  });
}

async function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // Usa o tar nativo do Windows (System32), não um tar qualquer do PATH.
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    try { await run(tar, ["-xf", archive, "-C", dest]); }
    catch (e1) {
      fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
      const q = (s) => s.replace(/'/g, "''");
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath '${q(archive)}' -DestinationPath '${q(dest)}' -Force`]);
    }
  } else {
    await run("tar", ["-xzf", archive, "-C", dest]);
  }
}

function findJavaBin(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, "bin", exe);
  if (fs.existsSync(direct)) return direct;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findJavaBin(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

let inflight = null;

// Baixa e instala o Java <major>. Retorna o caminho do executável.
function install(major, send, log = () => {}) {
  if (inflight && inflight.major === major) return inflight.promise;
  const promise = (async () => {
    const existing = managedPath(major);
    if (existing) return existing;

    const base = runtimeDir();
    const tmp = path.join(base, `.tmp-${major}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    try {
      send("progress", { stage: `Preparando o Java ${major}`, done: 0, total: 0 });
      const pkg = await getPackage(major, log);
      log(`[java] baixando ${pkg.link}`);

      const archive = path.join(tmp, process.platform === "win32" ? "java.zip" : "java.tar.gz");
      const mb = (n) => (n / 1048576).toFixed(1);
      const sha = await download(pkg.link, archive, pkg.size, (done, total) =>
        send("progress", {
          stage: `Baixando o Java ${major}`,
          file: total ? `${mb(done)} / ${mb(total)} MB` : `${mb(done)} MB`,
          done, total,
        }));
      if (pkg.checksum && sha.toLowerCase() !== String(pkg.checksum).toLowerCase())
        throw new Error("O Java baixado veio corrompido (checksum não bate). Tente de novo.");

      send("progress", { stage: `Instalando o Java ${major}`, done: 0, total: 0 });
      const out = path.join(tmp, "x");
      try { await extract(archive, out); }
      catch (e) { throw new Error(`Não consegui extrair o Java: ${e.message}`); }

      const bin = findJavaBin(out);
      if (!bin) throw new Error("Java baixado, mas o executável não foi encontrado.");
      const home = path.dirname(path.dirname(bin));

      fs.rmSync(homeDir(major), { recursive: true, force: true });
      let moved = false, lastErr;
      for (let i = 0; i < 8 && !moved; i++) {
        try { fs.renameSync(home, homeDir(major)); moved = true; }
        catch (e) { lastErr = e; await sleep(750); }
      }
      if (!moved) {
        log(`[java] rename falhou (${why(lastErr)}). Copiando os arquivos…`);
        try { fs.cpSync(home, homeDir(major), { recursive: true }); }
        catch (e) { throw new Error(`Não consegui salvar o Java: ${why(e)}`); }
      }
      log(`[java] Java ${major} instalado em ${homeDir(major)}`);
      return managedPath(major);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  inflight = { major, promise };
  const clear = () => { if (inflight?.promise === promise) inflight = null; };
  promise.then(clear, clear);
  return promise;
}

module.exports = { managedPath, install };
