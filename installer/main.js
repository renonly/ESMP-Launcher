const { app, BrowserWindow, ipcMain, dialog, shell, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");

const PRODUCT = "ESMP Launcher";
let win;

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  win = new BrowserWindow({
    width: 800, height: 480, resizable: false, maximizable: false, frame: false, show: false,
    backgroundColor: "#0d0e10", title: "Instalar ESMP",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

const defaultDir = () => path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Programs", PRODUCT);
const REPO = "renonly/ESMP-Launcher";
const UA = { "User-Agent": "ESMP-Installer", Accept: "application/vnd.github+json" };
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

async function findSetup() {
  const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: UA });
  if (!r.ok) throw new Error(`Não consegui consultar a última versão (erro ${r.status}). Tente de novo em instantes.`);
  const rel = await r.json();
  const a = (rel.assets || []).find((x) => /^ESMP-Launcher-Setup-.*\.exe$/i.test(x.name));
  if (!a) throw new Error("A última versão não tem o instalador anexado.");
  return a.browser_download_url;
}
async function download(url, dest) {
  const res = await net.fetch(url, { headers: { "User-Agent": "ESMP-Installer" } });
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar o launcher (erro ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise((ok) => out.once("drain", ok));
    send("progress", total ? got / total : 0);
  }
  await new Promise((ok) => out.end(ok));
}

ipcMain.handle("defaultDir", () => defaultDir());
ipcMain.handle("chooseDir", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Onde instalar o ESMP?", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return path.basename(p).toLowerCase() === PRODUCT.toLowerCase() ? p : path.join(p, PRODUCT);
});

ipcMain.handle("install", async (_e, dir) => {
  dir = String(dir || "").trim().replace(/[\\/]+$/, "");
  if (!/^[a-zA-Z]:\\/.test(dir) || /["&|^%<>]/.test(dir)) return { ok: false, error: "Pasta inválida. Use um caminho como C:\\Games\\ESMP (sem & % ^ | < >)." };
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
  catch { return { ok: false, error: "Sem permissão pra instalar nessa pasta. Escolha outra." }; }
  const exe = path.join(os.tmpdir(), `esmp-setup-${Date.now()}.exe`);
  try {
    send("phase", "download");
    await download(await findSetup(), exe);
  } catch (e) {
    fs.rmSync(exe, { force: true });
    return { ok: false, error: e.message || "Não foi possível baixar o launcher. Verifique sua internet." };
  }
  send("phase", "install");
  return new Promise((resolve) => {
    exec(`"${exe}" /S /D=${dir}`, { windowsHide: true }, (err) => {
      fs.rmSync(exe, { force: true });
      if (err) return resolve({ ok: false, error: `A instalação falhou (código ${err.code ?? "?"}). Feche o launcher se estiver aberto e tente de novo.` });
      resolve(fs.existsSync(path.join(dir, `${PRODUCT}.exe`)) ? { ok: true } : { ok: false, error: "A instalação terminou, mas o programa não foi encontrado na pasta escolhida." });
    });
  });
});

ipcMain.handle("launch", async (_e, dir) => {
  const main = path.join(String(dir), `${PRODUCT}.exe`);
  if (fs.existsSync(main)) await shell.openPath(main);
  app.quit();
});
ipcMain.on("win", (_e, a) => {
  if (!win) return;
  if (a === "min") win.minimize();
  if (a === "close") app.quit();
});
