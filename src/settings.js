const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const cfg = require("./config");

const file = () => path.join(app.getPath("userData"), "settings.json");

const defaults = () => ({
  ramGb: cfg.DEFAULT_RAM_GB,
  javaPath: "",
  jvmArgs: "",
  jvmPreset: "g1",
  fullscreen: false,
  width: 0,
  height: 0,
  onLaunch: "minimize",
  launchAtStartup: false,
  accent: "#c4b5fd",
  bgPath: "",
  bgBlur: 6,
  bgDim: 55,
});

const int = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);

function sanitize(raw, base) {
  const s = { ...base, ...raw };
  return {
    ramGb: int(s.ramGb, 1, 64, base.ramGb),
    javaPath: String(s.javaPath || "").trim().slice(0, 500),
    jvmArgs: String(s.jvmArgs || "").trim().slice(0, 1000),
    jvmPreset: oneOf(s.jvmPreset, ["none", "g1"], "g1"),
    fullscreen: !!s.fullscreen,
    width: int(s.width, 0, 10000, 0),
    height: int(s.height, 0, 10000, 0),
    onLaunch: oneOf(s.onLaunch, ["minimize", "keep", "quit"], "minimize"),
    launchAtStartup: !!s.launchAtStartup,
    accent: /^#[0-9a-f]{6}$/i.test(s.accent) ? s.accent : base.accent,
    bgPath: String(s.bgPath || "").slice(0, 500),
    bgBlur: int(s.bgBlur, 0, 30, 6),
    bgDim: int(s.bgDim, 0, 90, 55),
  };
}

function load() {
  try { return sanitize(JSON.parse(fs.readFileSync(file(), "utf8")), defaults()); }
  catch { return defaults(); }
}

function save(patch) {
  const next = sanitize(patch, load());
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}

const reset = () => save(defaults());

module.exports = { load, save, reset };
