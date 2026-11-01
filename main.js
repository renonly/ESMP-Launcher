const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const { pathToFileURL } = require("url");
const os = require("os");
const path = require("path");
const fs = require("fs");
const auth = require("./src/auth");
const game = require("./src/game");
const updater = require("./src/updater");
const status = require("./src/status");
const settings = require("./src/settings");
const stats = require("./src/stats");
const news = require("./src/news");
const cfg = require("./src/config");

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win;
let running = false;
let gameProc = null;
let startedAt = 0;

const userFile = (n) => path.join(app.getPath("userData"), n);
const log = (...a) => {
  try {
    fs.appendFileSync(userFile("launcher.log"),
      `[${new Date().toISOString()}] ${a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" ")}\n`);
  } catch {}
};

process.on("uncaughtException", (e) => log("uncaughtException", e));
process.on("unhandledRejection", (e) => log("unhandledRejection", e instanceof Error ? e : new Error(String(e))));
app.on("child-process-gone", (_e, d) => log("child-process-gone", JSON.stringify(d)));

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 680, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: "#0d0e10", show: false,
    icon: fs.existsSync(path.join(__dirname, "build", "icon.png"))
      ? path.join(__dirname, "build", "icon.png") : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 4000);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.on("console-message", (_e, level, msg, line, src) => { if (level >= 2) log("renderer:", msg, `(${src}:${line})`); });
  win.webContents.on("render-process-gone", (_e, d) => log("render-process-gone", JSON.stringify(d)));
  win.webContents.on("unresponsive", () => log("janela não está respondendo"));
  win.webContents.on("preload-error", (_e, p, err) => log("preload-error", p, err));
  win.webContents.on("did-fail-load", (_e, code, desc) => log("did-fail-load", code, desc));
  win.webContents.on("before-input-event", (_e, i) => {
    if (i.type === "keyDown" && (i.key === "F12" || (i.control && i.shift && i.key.toLowerCase() === "i")))
      win.webContents.toggleDevTools();
  });
  win.webContents.once("did-finish-load", () => setTimeout(() => checkUpdates(false), 2500));
}
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

let upd = { state: "idle", current: app.getVersion() };
const setUpd = (state, extra = {}) => {
  upd = { state, current: app.getVersion(), ...extra };
  if (win && !win.isDestroyed()) win.webContents.send("update:status", upd);
};
const newer = (a, b) => {
  const p = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function fallbackCheck(reason) {
  try {
    const res = await fetch(`https://api.github.com/repos/${cfg.GITHUB_REPO}/releases/latest`, {
      headers: { "user-agent": "lsmp-launcher" }, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return setUpd("error", { message: "Repositório sem Release pública. O repositório precisa ser público e ter uma Release publicada." });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    if (newer(r.tag_name, app.getVersion()))
      return setUpd("manual", { version: r.tag_name.replace(/^v/, ""), url: r.html_url, message: reason });
    setUpd("none");
  } catch (e) {
    setUpd("error", { message: "Não consegui verificar atualizações. Verifique sua internet." });
  }
}

function initUpdater() {
  autoUpdater.logger = { info: log, warn: log, error: log, debug() {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => setUpd("checking"));
  autoUpdater.on("update-available", (i) => setUpd("downloading", { version: i.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => setUpd("none"));
  autoUpdater.on("download-progress", (p) =>
    setUpd("downloading", { version: upd.version, percent: Math.round(p.percent || 0) }));
  autoUpdater.on("update-downloaded", (i) => setUpd("ready", { version: i.version }));
  autoUpdater.on("error", (e) => { log("updater error", e); fallbackCheck(String(e && e.message || e).slice(0, 200)); });
}

async function checkUpdates(manual) {
  if (!app.isPackaged) { setUpd("dev"); return upd; }
  if (["checking", "downloading", "ready"].includes(upd.state)) return upd;
  setUpd("checking");
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { log("check failed", e); await fallbackCheck(String(e.message || e).slice(0, 200)); }
  return upd;
}

initUpdater();
setInterval(() => checkUpdates(false), 20 * 60 * 1000);

ipcMain.handle("update:state", () => upd);
ipcMain.handle("update:check", () => checkUpdates(true));
ipcMain.on("update:install", () => {
  if (upd.state === "ready") setImmediate(() => autoUpdater.quitAndInstall(true, true));
});

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message }; }
};
const toRenderer = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(`game:${ch}`, data);
};
const bgUrl = (s) => (s.bgPath && fs.existsSync(s.bgPath) ? pathToFileURL(s.bgPath).href : "");
const withBg = (s) => ({ ...s, bgUrl: bgUrl(s) });

ipcMain.handle("auth:session", () => auth.load());
ipcMain.handle("auth:login", wrap(auth.login));
ipcMain.handle("auth:register", wrap(auth.register));
ipcMain.handle("auth:logout", () => auth.logout());

ipcMain.handle("config", () => ({
  name: cfg.SERVER_NAME, mc: cfg.MC_VERSION, host: cfg.SERVER_HOST, port: cfg.SERVER_PORT,
  maxRam: Math.min(32, Math.max(2, Math.floor(os.totalmem() / 1024 ** 3))),
  totalRam: Math.round(os.totalmem() / 1024 ** 3),
  version: app.getVersion(), repo: cfg.GITHUB_REPO, packaged: app.isPackaged,
}));

ipcMain.handle("settings:get", () => withBg(settings.load()));
ipcMain.handle("settings:set", (_e, patch) => {
  const s = settings.save(patch);
  if (patch && "launchAtStartup" in patch && app.isPackaged)
    app.setLoginItemSettings({ openAtLogin: s.launchAtStartup });
  return withBg(s);
});
ipcMain.handle("settings:reset", () => withBg(settings.reset()));
ipcMain.handle("status:server", () => status.ping(cfg.SERVER_HOST, cfg.SERVER_PORT));
ipcMain.handle("pack:info", wrap(() => updater.info(game.gameDir())));
ipcMain.handle("game:installed", () => game.isInstalled());
ipcMain.handle("stats", () => stats.load());
ipcMain.handle("news", () => news.get());

ipcMain.handle("bg:choose", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Escolher imagem de fundo", properties: ["openFile"],
    filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (r.canceled || !r.filePaths[0]) return withBg(settings.load());
  const ext = path.extname(r.filePaths[0]).toLowerCase();
  const dest = userFile(`background-${Date.now()}${ext}`);
  fs.copyFileSync(r.filePaths[0], dest);
  const old = settings.load().bgPath;
  const s = settings.save({ bgPath: dest });
  if (old && old !== dest) try { fs.unlinkSync(old); } catch {}
  return withBg(s);
});
ipcMain.handle("bg:clear", () => {
  const old = settings.load().bgPath;
  if (old) try { fs.unlinkSync(old); } catch {}
  return withBg(settings.save({ bgPath: "" }));
});

ipcMain.handle("java:detect", () => game.detectJava());
ipcMain.handle("java:choose", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Escolher o java.exe", properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "Java", extensions: ["exe"] }] : [],
  });
  return r.canceled ? "" : r.filePaths[0];
});

const shotsDir = () => path.join(game.gameDir(), "screenshots");
ipcMain.handle("shots:list", () => {
  const dir = shotsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .map((f) => { const p = path.join(dir, f); return { name: f, path: p, url: pathToFileURL(p).href, time: fs.statSync(p).mtimeMs }; })
    .sort((a, b) => b.time - a.time).slice(0, 80);
});
ipcMain.handle("shots:show", (_e, p) => {
  if (path.resolve(p).startsWith(path.resolve(shotsDir()))) shell.showItemInFolder(p);
});

ipcMain.handle("shell:openGame", () => { fs.mkdirSync(game.gameDir(), { recursive: true }); return shell.openPath(game.gameDir()); });
ipcMain.handle("shell:openShots", () => { fs.mkdirSync(shotsDir(), { recursive: true }); return shell.openPath(shotsDir()); });
ipcMain.handle("shell:openData", () => shell.openPath(app.getPath("userData")));
ipcMain.handle("shell:openLog", () => shell.openPath(userFile("launcher.log")));
ipcMain.handle("shell:external", (_e, url) => {
  if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url);
});
ipcMain.on("clipboard:copy", (_e, text) => clipboard.writeText(String(text)));

ipcMain.handle("game:play", wrap(async () => {
  if (running) throw new Error("O jogo já está em execução.");
  const session = auth.load();
  if (!session) throw new Error("Faça login primeiro.");
  const s = settings.load();
  running = true;
  try {
    gameProc = await game.play(session, s, (ch, data) => {
      toRenderer(ch, data);
      if (ch === "started") {
        startedAt = Date.now();
        stats.launched();
        if (s.onLaunch === "minimize") win.minimize();
        if (s.onLaunch === "quit") setTimeout(() => app.quit(), 1500);
      }
      if (ch === "closed") {
        running = false; gameProc = null;
        if (startedAt) stats.played(Date.now() - startedAt);
        startedAt = 0;
        if (s.onLaunch === "minimize" && win && !win.isDestroyed()) { win.restore(); win.focus(); }
      }
    });
  } catch (err) { running = false; throw err; }
}));
ipcMain.handle("game:stop", () => { if (gameProc) gameProc.kill(); });
ipcMain.handle("game:sync", wrap(async (force) => {
  if (running) throw new Error("Feche o jogo antes de verificar os arquivos.");
  running = true;
  try { await game.syncOnly(!!force, toRenderer); }
  finally { running = false; }
}));

ipcMain.handle("game:uninstall", wrap(async () => {
  if (running) throw new Error("Feche o jogo antes de desinstalar.");
  const dir = game.gameDir();
  if (path.basename(dir) !== "instance") throw new Error("Pasta do jogo inesperada, nada foi apagado.");
  if (!fs.existsSync(dir)) return { removed: false, reason: "Nada instalado." };
  const { response } = await dialog.showMessageBox(win, {
    type: "warning", title: "Desinstalar Minecraft", noLink: true, cancelId: 0, defaultId: 0,
    buttons: ["Cancelar", "Desinstalar (manter mundos e capturas)", "Desinstalar tudo"],
    message: "Desinstalar o Minecraft do ESMP?",
    detail: "Apaga os mods, configs e arquivos do jogo deste computador. Sua conta e os ajustes do launcher não são afetados.\n\n" +
            "\"Manter mundos e capturas\" preserva as pastas saves e screenshots. \"Desinstalar tudo\" apaga também seus mundos do singleplayer.",
  });
  if (response === 0) return { removed: false, cancelled: true };
  running = true;
  try {
    const keep = response === 1 ? new Set(["saves", "screenshots"]) : new Set();
    const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 300 };
    if (keep.size === 0) fs.rmSync(dir, opts);
    else for (const name of fs.readdirSync(dir)) if (!keep.has(name)) fs.rmSync(path.join(dir, name), opts);
  } finally { running = false; }
  return { removed: true, kept: response === 1 };
}));

ipcMain.on("win", (_e, action) => {
  if (!win || win.isDestroyed()) return;
  if (action === "min") win.minimize();
  if (action === "max") win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === "close") win.close();
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
