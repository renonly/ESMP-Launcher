const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const setup = fs.existsSync(dist) && fs.readdirSync(dist).filter((f) => /^ESMP-Launcher-Setup-.*\.exe$/i.test(f)).sort().pop();
if (!setup) { console.error("Não achei dist/ESMP-Launcher-Setup-*.exe. Rode `npm run dist` antes."); process.exit(1); }
const out = path.join(__dirname, "payload");
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { force: true });
fs.copyFileSync(path.join(dist, setup), path.join(out, "setup.exe"));
console.log("payload:", setup);
