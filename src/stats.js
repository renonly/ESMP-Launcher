const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const file = () => path.join(app.getPath("userData"), "stats.json");

function load() {
  try { return { playMs: 0, launches: 0, last: 0, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; }
  catch { return { playMs: 0, launches: 0, last: 0 }; }
}
function save(s) { try { fs.writeFileSync(file(), JSON.stringify(s)); } catch {} }
function launched() { const s = load(); s.launches++; s.last = Date.now(); save(s); }
function played(ms) { const s = load(); s.playMs += Math.max(0, ms); save(s); }

module.exports = { load, launched, played };
