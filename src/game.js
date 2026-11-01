const { Client } = require("minecraft-launcher-core");
const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const { app } = require("electron");
const cfg = require("./config");
const updater = require("./updater");
const { neoJvmArgs, tailLogs } = require("./neoargs");

const gameDir = () => path.join(app.getPath("userData"), "instance");

async function ensureFabric(root, mc, loader) {
  const id = `fabric-loader-${loader}-${mc}`;
  const jsonPath = path.join(root, "versions", id, `${id}.json`);
  if (!fs.existsSync(jsonPath)) {
    const url = `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`;
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error("Não consegui baixar o Fabric. Verifique sua internet."); }
    if (!res.ok) throw new Error("Não consegui baixar o Fabric.");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, await res.text());
  }
  return id;
}

async function ensureForge(root, mc, loader) {
  const name = `forge-${mc}-${loader}-installer.jar`;
  const dest = path.join(root, "forge", name);
  if (!fs.existsSync(dest)) {
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${loader}/${name}`;
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error("Não consegui baixar o Forge. Verifique sua internet."); }
    if (!res.ok) throw new Error(`Não achei o Forge ${loader} para o Minecraft ${mc} (HTTP ${res.status}).`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".part";
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }
  return dest;
}

async function ensureNeoForge(root, loader, javaPath, log) {
  const id = `neoforge-${loader}`;
  if (fs.existsSync(path.join(root, "versions", id, `${id}.json`))) return id;
  const name = `neoforge-${loader}-installer.jar`;
  const dest = path.join(root, "neoforge", name);
  if (!fs.existsSync(dest)) {
    const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/${name}`;
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error("Não consegui baixar o NeoForge. Verifique sua internet."); }
    if (!res.ok) throw new Error(`Não achei o NeoForge ${loader} (HTTP ${res.status}).`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".part";
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
  }
  const prof = path.join(root, "launcher_profiles.json");
  if (!fs.existsSync(prof)) fs.writeFileSync(prof, JSON.stringify({ profiles: {} }));
  await new Promise((resolve, reject) => {
    const p = spawn(javaPath || "java", ["-jar", dest, "--installClient", root], { cwd: root });
    p.stdout.on("data", log); p.stderr.on("data", log);
    p.on("error", () => reject(new Error("Não consegui rodar o instalador do NeoForge (Java ok?).")));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`Instalador do NeoForge falhou (código ${c}). Veja a aba Console.`))));
  });
  if (!fs.existsSync(path.join(root, "versions", id, `${id}.json`)))
    throw new Error("NeoForge instalado, mas o perfil não foi encontrado. Veja a aba Console.");
  return id;
}

function requiredJava(mc) {
  const [, minor = "0", patch = "0"] = mc.split(".");
  const m = Number(minor), p = Number(patch);
  if (m > 20 || (m === 20 && p >= 5)) return 21;
  if (m >= 18) return 17;
  if (m === 17) return 16;
  return 8;
}

function javaMajor(javaPath) {
  const r = spawnSync(javaPath || "java", ["-version"], { encoding: "utf8", timeout: 8000 });
  if (r.error) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}

const PRESETS = {
  none: [],
  g1: ["-XX:+UseG1GC", "-XX:MaxGCPauseMillis=100", "-XX:+UnlockExperimentalVMOptions",
       "-XX:+DisableExplicitGC", "-XX:G1NewSizePercent=20", "-XX:G1ReservePercent=20",
       "-XX:G1HeapRegionSize=32M"],
};

function detectJava() {
  const found = new Map();
  const add = (p) => {
    if (!p || found.has(p) || !fs.existsSync(p)) return;
    const major = javaMajor(p);
    if (major) found.set(p, { path: p, major });
  };
  const exe = process.platform === "win32" ? "java.exe" : "java";
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, "bin", exe));
  const roots = process.platform === "win32"
    ? ["C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Java", "C:\\Program Files\\Microsoft",
       "C:\\Program Files\\Zulu", "C:\\Program Files\\BellSoft", "C:\\Program Files\\Amazon Corretto"]
    : ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r)) {
      add(path.join(r, d, "bin", exe));
      add(path.join(r, d, "Contents", "Home", "bin", exe));
    }
  }
  return [...found.values()].sort((a, b) => b.major - a.major);
}

function checkJava(mc, javaPath) {
  const need = requiredJava(mc);
  const have = javaMajor(javaPath);
  if (have === null)
    throw new Error(`Java não encontrado. Instale o Java ${need} (Temurin) ou informe o caminho em Ajustes.`);
  if (have < need)
    throw new Error(`Seu Java é o ${have}, mas o Minecraft ${mc} precisa do Java ${need} ou mais novo.`);
}

async function syncOnly(force, send) {
  const root = gameDir();
  fs.mkdirSync(root, { recursive: true });
  return updater.sync(root, (p) => send("progress", p), { force });
}

async function play(session, s, send) {
  const root = gameDir();
  fs.mkdirSync(root, { recursive: true });

  const manifest = await updater.sync(root, (p) => send("progress", p));
  const mc = typeof manifest.minecraft === "string"
    ? manifest.minecraft
    : manifest.minecraft?.version || cfg.MC_VERSION;
  const loaderType = (manifest.loader?.type || "fabric").toLowerCase();
  if (!["fabric", "forge", "neoforge"].includes(loaderType))
    throw new Error(`Este pack usa ${loaderType}, mas o launcher só suporta Fabric, Forge e NeoForge.`);
  const loader = manifest.loader?.version || ({ forge: cfg.FORGE_LOADER, neoforge: cfg.NEOFORGE_LOADER }[loaderType] || cfg.FABRIC_LOADER);

  send("progress", { stage: "Verificando o Java", done: 0, total: 0 });
  checkJava(mc, s.javaPath);
  const log = (m) => String(m).split(/\r?\n/).filter(Boolean).forEach((l) => send("log", l));
  let fabricId = null, forgeInstaller = null;
  if (loaderType === "neoforge") fabricId = await ensureNeoForge(root, loader, s.javaPath, log);
  else if (loaderType === "forge") forgeInstaller = await ensureForge(root, mc, loader);
  else fabricId = await ensureFabric(root, mc, loader);

  const launcher = new Client();
  launcher.on("progress", (e) =>
    send("progress", { stage: `Baixando ${e.type}`, done: e.task, total: e.total })
  );
  launcher.on("debug", log);
  launcher.on("data", log);
  launcher.on("close", (code) => { if (code) tailLogs(root, log); send("closed", code); });

  const opts = {
    authorization: {
      access_token: session.token,
      client_token: session.uuid,
      uuid: session.uuid,
      name: session.username,
      user_properties: "{}",
      meta: { type: "mojang", demo: false },
    },
    root,
    version: fabricId ? { number: mc, type: "release", custom: fabricId } : { number: mc, type: "release" },
    ...(forgeInstaller ? { forge: forgeInstaller } : {}),
    memory: { max: `${s.ramGb}G`, min: `${Math.max(1, Math.min(2, s.ramGb))}G` },
    server: { host: cfg.SERVER_HOST, port: cfg.SERVER_PORT },
  };
  if (s.javaPath) opts.javaPath = s.javaPath;
  opts.detached = false;
  const neoArgs = loaderType === "neoforge" ? neoJvmArgs(root, fabricId, log) : [];
  const extra = [...neoArgs, ...(PRESETS[s.jvmPreset] || []), ...s.jvmArgs.split(/\s+/).filter(Boolean)];
  if (extra.length) opts.customArgs = extra;
  if (s.fullscreen) opts.window = { fullscreen: true };
  else if (s.width && s.height) opts.window = { width: s.width, height: s.height };

  send("progress", { stage: "Iniciando o jogo", done: 0, total: 0 });
  const proc = await launcher.launch(opts);
  if (!proc) throw new Error("O Minecraft não conseguiu iniciar. Veja a aba Console.");
  send("progress", { stage: "Jogo iniciado", done: 1, total: 1 });
  send("started");
  return proc;
}

const isInstalled = () => updater.isInstalled(gameDir());
module.exports = { play, syncOnly, gameDir, detectJava, isInstalled };
