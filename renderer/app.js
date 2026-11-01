const $ = (id) => document.getElementById(id);
const api = window.lsmp;
const state = { installed: true, cfg: null, s: null, session: null, status: null, busy: false, running: false, pack: null, shot: null };
const COLORS = ["#4ade80", "#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#facc15", "#f87171", "#2dd4bf"];

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.id); toast.id = setTimeout(() => (t.hidden = true), 2600);
}
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const fmtDate = (d) => new Date(d).toLocaleDateString("pt-BR");
const fmtHours = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} min` : `${(m / 60).toFixed(1).replace(".0", "")} h`; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

document.querySelectorAll("img.logo, img.logo-sm").forEach((img) => {
  const drop = () => img.remove();
  img.addEventListener("error", drop);
  if (img.complete && img.naturalWidth === 0) drop();
});

function go(tab) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.dataset.view !== tab));
  if (tab === "pack") loadPack();
  if (tab === "news") loadNews();
  if (tab === "shots") loadShots();
  if (tab === "settings") loadPackChip().then(renderSettingsPackInfo);
}
$("nav").onclick = (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.tab); };
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]"); if (g) { e.preventDefault(); go(g.dataset.goto); }
  const w = e.target.closest("[data-win]"); if (w) api.win(w.dataset.win);
  if (e.target.closest("[data-open-dir]")) api.openGameDir();
  const x = e.target.closest("a[data-ext]"); if (x) { e.preventDefault(); api.openExternal(x.dataset.ext); }
});
$("subtabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#subtabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".sub-pane").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.sub));
};

let registering = false;
function setMode(reg) {
  registering = reg;
  $("auth-title").textContent = reg ? "Criar conta" : "Entrar";
  $("auth-submit").textContent = reg ? "Criar conta" : "Entrar";
  $("auth-toggle").textContent = reg ? "Já tenho conta" : "Criar uma conta";
  $("p2-wrap").hidden = !reg; $("auth-error").textContent = "";
}
$("auth-toggle").onclick = () => setMode(!registering);
async function submitAuth() {
  const u = $("u").value.trim(), p = $("p").value;
  $("auth-error").textContent = "";
  if (!u || !p) return ($("auth-error").textContent = "Preencha usuário e senha.");
  if (registering && p !== $("p2").value) return ($("auth-error").textContent = "As senhas não são iguais.");
  $("auth-submit").disabled = true;
  const r = await (registering ? api.register(u, p) : api.login(u, p));
  $("auth-submit").disabled = false;
  if (!r.ok) return ($("auth-error").textContent = r.error);
  $("p").value = $("p2").value = "";
  enter(r.data);
}
$("auth-submit").onclick = submitAuth;
["u", "p", "p2"].forEach((id) => $(id).addEventListener("keydown", (e) => e.key === "Enter" && submitAuth()));
$("logout").onclick = async () => { await api.logout(); state.session = null; $("app").hidden = true; $("auth").hidden = false; };

function enter(session) {
  state.session = session;
  $("auth").hidden = true; $("app").hidden = false;
  $("who").textContent = session.username;
  $("avatar").textContent = session.username[0].toUpperCase();
  go("play"); refreshStatus(); loadNews(true); loadPackChip(); refreshInstalled();
}

function applyLook() {}

async function refreshStatus() {
  const st = await api.status();
  state.status = st;
  $("srv-dot").className = "dot " + (st.online ? "on" : "off");
  $("t-players").textContent = st.online ? `${st.players}/${st.max}` : "Offline";
  $("t-ping").textContent = st.online ? st.ping + " ms" : "—";
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function mdInline(text, parent) {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;
  let last = 0, m;
  const link = (label, url) => { const a = el("a", "md-link", label); a.href = "#"; a.dataset.ext = url; a.title = url; return a; };
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[1] != null) parent.append(el("code", null, m[1]));
    else if (m[2] != null || m[3] != null) { const b = el("strong"); mdInline(m[2] ?? m[3], b); parent.append(b); }
    else if (m[4] != null || m[5] != null) { const i = el("em"); mdInline(m[4] ?? m[5], i); parent.append(i); }
    else if (m[6] != null) parent.append(link(m[6], m[7]));
    else parent.append(link(m[8].replace(/[.,;:!?]+$/, ""), m[8].replace(/[.,;:!?]+$/, "")));
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function renderMarkdown(src, skipTitles = []) {
  const root = el("div", "md");
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  let list = null, para = null, first = true;
  const flush = () => { list = null; para = null; };
  for (const raw of lines) {
    const line = raw.trimEnd(), t = line.trim();
    if (!t) { flush(); continue; }
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const title = m[2].trim();
      if (first && skipTitles.some((s) => s && title.toLowerCase().includes(String(s).toLowerCase()))) { first = false; continue; }
      first = false;
      const h = el("h" + Math.min(6, Math.max(3, m[1].length + 1)), "md-h"); mdInline(title, h); root.append(h); continue;
    }
    first = false;
    if (/^([-*_])\1{2,}$/.test(t)) { flush(); root.append(el("hr")); continue; }
    if ((m = t.match(/^[-*+]\s+(.*)$/))) {
      if (!list || list.tagName !== "UL") { list = el("ul"); root.append(list); para = null; }
      const li = el("li"); mdInline(m[1], li); list.append(li); continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      if (!list || list.tagName !== "OL") { list = el("ol"); root.append(list); para = null; }
      const li = el("li"); mdInline(m[1], li); list.append(li); continue;
    }
    if ((m = t.match(/^>\s?(.*)$/))) {
      flush(); const q = el("blockquote"); mdInline(m[1], q); root.append(q); continue;
    }
    list = null;
    if (!para) { para = el("p"); root.append(para); } else para.append(document.createElement("br"));
    mdInline(t, para);
  }
  return root;
}
function mdSummary(body) {
  for (const raw of String(body || "").split("\n")) {
    let t = raw.trim();
    if (!t || /^#{1,6}\s/.test(t) || /full changelog/i.test(t)) continue;
    t = t.replace(/^([-*+]|\d+[.)]|>)\s+/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
    if (t) return t;
  }
  return "";
}

async function loadNews(small) {
  const list = await api.news();
  if (list.length) {
    $("latest").hidden = false;
    $("latest-tag").textContent = list[0].tag;
    $("latest-title").textContent = list[0].name;
    $("latest-body").textContent = mdSummary(list[0].body);
  }
  if (small) return;
  const box = $("news-list");
  if (!list.length) { box.innerHTML = ""; const p = document.createElement("p"); p.className = "note"; p.textContent = "Sem novidades por enquanto."; return box.append(p); }
  box.replaceChildren(...list.map((n) => {
    const d = document.createElement("div"); d.className = "news-item";
    const h = document.createElement("header");
    const t = document.createElement("span"); t.className = "tag"; t.textContent = n.tag;
    const b = document.createElement("b"); b.textContent = n.name;
    const dt = document.createElement("span"); dt.className = "d"; dt.textContent = fmtDate(n.date);
    h.append(t, b, dt);
    const body = n.body ? renderMarkdown(n.body, [n.tag, n.name]) : el("p", "note", "Sem descrição.");
    d.append(h, body); return d;
  }));
}

function updatePlayBtn() { $("play").textContent = state.installed ? "Jogar" : "Instalar"; }
async function refreshInstalled() {
  try { state.installed = !!(await api.installed()); } catch { state.installed = true; }
  updatePlayBtn();
}
async function installGame() { if (!state.busy && !state.running) await runSync(false, true); }

async function loadPackChip() {
  const r = await api.packInfo();
  if (r.ok) state.pack = r.data;
  return r;
}
async function loadPack() {
  const r = await loadPackChip();
  $("pack-error").textContent = r.ok ? "" : r.error;
  if (r.ok) renderPack();
}
const KIND_LABEL = { mods: "Mod", shaderpacks: "Shader", resourcepacks: "Resource pack", config: "Config" };
const kindOf = (p) => { const k = p.split("/")[0]; return KIND_LABEL[k] ? k : "mods"; };
const statusOf = (x) => (x.installed ? "ok" : x.status === "outdated" ? "outdated" : "miss");
function renderPack() {
  const p = state.pack; if (!p) return;
  const q = $("pack-search").value.toLowerCase(), kind = $("pack-kind").value, f = $("pack-filter").value, so = $("pack-sort").value;
  const total = p.files.reduce((s, x) => s + x.size, 0), ok = p.files.filter((x) => x.installed).length;
  const chip = (t) => { const c = document.createElement("span"); c.className = "chip static"; c.textContent = t; return c; };
  $("pack-stats").replaceChildren(chip(`${p.files.length} arquivos`), chip(fmtSize(total)), chip(`${ok} instalados`));

  const bn = $("pack-banner"), bt = $("pack-banner-text"), bu = $("pack-update");
  bn.hidden = false; bn.className = "banner"; bu.hidden = true;
  if (p.offline) { bn.classList.add("warn"); bt.textContent = "⚠ Sem conexão: não deu pra checar atualizações"; }
  else if (p.updateAvailable) { bn.classList.add("update"); bt.textContent = `⬆ Atualização disponível: v${p.version} (${p.pendingCount} arquivo(s), ${fmtSize(p.pendingSize)})`; bu.hidden = false; }
  else { bn.classList.add("good"); bt.textContent = `✓ Tudo atualizado (v${p.version})`; }

  const rank = { outdated: 0, miss: 1, ok: 2 };
  let files = p.files.filter((x) => x.path.toLowerCase().includes(q) && (kind === "all" || kindOf(x.path) === kind) && (f === "all" || statusOf(x) === f));
  files.sort((a, b) => so === "size" ? b.size - a.size : so === "status" ? rank[statusOf(a)] - rank[statusOf(b)] || a.path.localeCompare(b.path) : a.path.localeCompare(b.path));
  $("pack-empty").hidden = files.length > 0;
  $("pack-list").replaceChildren(...files.map((x) => {
    const st = statusOf(x), k = kindOf(x.path);
    const d = document.createElement("div"); d.className = "item";
    const tag = document.createElement("span"); tag.className = "kind " + k; tag.textContent = KIND_LABEL[k];
    const n = document.createElement("span"); n.className = "n"; n.textContent = x.path.slice(x.path.indexOf("/") + 1); n.title = x.path;
    const s = document.createElement("span"); s.className = "s"; s.textContent = fmtSize(x.size);
    const c = document.createElement("span"); c.className = st === "ok" ? "ok" : "miss";
    c.textContent = st === "ok" ? "✓" : st === "outdated" ? "⬆" : "✗";
    c.title = st === "ok" ? "Atualizado" : st === "outdated" ? "Desatualizado" : "Faltando";
    d.append(tag, n, s, c); return d;
  }));
  renderSettingsPackInfo();
}
function renderSettingsPackInfo() {
  const p = state.pack, el = $("s-pack-info"); if (!el) return;
  if (!p) { el.textContent = "Sem informação do pack ainda."; return; }
  const bad = p.files.filter((x) => !x.installed).length;
  el.textContent = p.offline ? "Sem conexão: não deu pra checar atualizações."
    : p.updateAvailable ? `Atualização disponível: v${p.version} (${p.pendingCount} arquivo(s), ${fmtSize(p.pendingSize)}).`
    : bad ? `Pack v${p.version}: ${bad} arquivo(s) faltando ou desatualizado(s).` : `Pack v${p.version} em dia. ${p.files.length} arquivos instalados.`;
}
["pack-search", "pack-kind", "pack-filter", "pack-sort"].forEach((id) => $(id).addEventListener("input", renderPack));

async function runSync(force, installing) {
  if (state.busy) return;
  setBusy(true); $("game-error").textContent = ""; $("pack-error").textContent = ""; $("s-sync-error").textContent = "";
  const r = await api.sync(force);
  setBusy(false);
  if (!r.ok) { $("game-error").textContent = r.error; $("pack-error").textContent = r.error; $("s-sync-error").textContent = r.error; }
  else toast(installing ? "Minecraft instalado! Clique em Jogar." : force ? "Arquivos reparados!" : "Pack verificado e atualizado!");
  loadPack(); refreshInstalled();
}
const confirmRepair = () => confirm("Reparar vai baixar TODOS os arquivos do pack de novo. Para só atualizar o que mudou, use 'Verificar atualizações' (Ajustes → Jogo). Continuar?") && runSync(true);
$("pack-update").onclick = () => runSync(false);
$("s-check").onclick = () => runSync(false);
$("s-repair").onclick = confirmRepair;
$("s-uninstall").onclick = async () => {
  if (state.busy || state.running) return;
  $("s-sync-error").textContent = "";
  setBusy(true);
  const r = await api.uninstall();
  setBusy(false);
  if (!r.ok) { $("s-sync-error").textContent = r.error; return; }
  const d = r.data || {};
  if (d.cancelled) return;
  if (!d.removed) { toast(d.reason || "Nada para desinstalar."); return; }
  toast(d.kept ? "Minecraft desinstalado (mundos e capturas mantidos)." : "Minecraft desinstalado.");
  loadPack(); refreshInstalled();
};

async function loadShots() {
  const list = await api.shots();
  $("shots-empty").hidden = list.length > 0;
  $("shots-grid").replaceChildren(...list.map((s) => {
    const i = document.createElement("img"); i.src = s.url; i.loading = "lazy"; i.title = s.name;
    i.onclick = () => { state.shot = s; $("lb-img").src = s.url; $("lightbox").hidden = false; };
    return i;
  }));
}
$("shots-refresh").onclick = loadShots; $("shots-open").onclick = () => api.openShots();
$("lb-close").onclick = () => ($("lightbox").hidden = true);
$("lightbox").onclick = (e) => { if (e.target.id === "lightbox") $("lightbox").hidden = true; };
$("lb-show").onclick = () => state.shot && api.showShot(state.shot.path);

function setBusy(b) {
  state.busy = b;
  $("play").disabled = b || state.running; $("pack-update").disabled = b; $("s-check").disabled = b || state.running; $("s-repair").disabled = b || state.running; $("s-uninstall").disabled = b || state.running;
  $("progress").hidden = !b && !state.running;
  if (!b && !state.running) { $("bar-fill").style.width = "0"; $("s-bar-fill").style.width = "0"; $("s-progress").hidden = true; }
}
function setRunning(r) {
  state.running = r; $("play").hidden = r; $("stop").hidden = !r; $("s-check").disabled = r || state.busy; $("s-repair").disabled = r || state.busy; $("s-uninstall").disabled = r || state.busy;
  $("play").disabled = state.busy || r;
}
api.on("progress", (p) => {
  $("progress").hidden = false;
  $("stage").textContent = p.stage; $("file").textContent = p.file || "";
  const w = p.total ? Math.min(100, (p.done / p.total) * 100) + "%" : "100%";
  $("bar-fill").style.width = w;
  $("s-progress").hidden = false; $("s-stage").textContent = p.stage; $("s-file").textContent = p.file || ""; $("s-bar-fill").style.width = w;
});
const logEl = $("log");
api.on("log", (l) => {
  logEl.append(l + "\n");
  if (logEl.textContent.length > 300000) logEl.textContent = logEl.textContent.slice(-200000);
  logEl.scrollTop = logEl.scrollHeight;
});
api.on("started", () => { setBusy(false); setRunning(true); $("progress").hidden = true; $("s-progress").hidden = true; });
api.on("closed", (code) => {
  setRunning(false); setBusy(false); refreshInstalled();
  if (code) { $("game-error").textContent = `O jogo fechou com erro (código ${code}). Veja a aba Console.`; }
});
$("play").onclick = async () => {
  if (state.busy || state.running) return;
  if (!state.installed) return installGame();
  $("game-error").textContent = ""; setBusy(true);
  const r = await api.play();
  if (!r.ok) { setBusy(false); $("game-error").textContent = r.error; }
};
$("stop").onclick = () => api.stop();
$("log-copy").onclick = () => { api.copy(logEl.textContent); toast("Log copiado!"); };
$("log-clear").onclick = () => (logEl.textContent = "");

function fillSettings(s) {
  state.s = s;
  $("s-ram").value = s.ramGb;
  $("s-ram-val").textContent = s.ramGb;
  $("s-fullscreen").checked = s.fullscreen;
  $("s-width").value = s.width || ""; $("s-height").value = s.height || "";
  $("s-onlaunch").value = s.onLaunch; $("s-java").value = s.javaPath;
  $("s-preset").value = s.jvmPreset; $("s-jvm").value = s.jvmArgs;
  $("s-startup").checked = s.launchAtStartup;
  applyLook(s);
}
const save = debounce(async (patch) => { fillSettingsLight(await api.setSettings(patch)); }, 250);
function fillSettingsLight(s) { state.s = s; applyLook(s); }
const set = (patch) => { Object.assign(state.s, patch); applyLook(state.s); save(patch); };

function ramSync(v) {
  $("s-ram").value = v; $("s-ram-val").textContent = v;
  set({ ramGb: Number(v) });
  const rec = Math.max(2, Math.min(8, Math.floor(state.cfg.totalRam / 2)));
  $("s-ram-hint").textContent = Number(v) > state.cfg.totalRam * 0.75 ? "(muito alto pro seu PC)" : `(recomendado: ${rec} GB)`;
}
$("s-ram").oninput = (e) => ramSync(e.target.value);
$("s-fullscreen").onchange = (e) => set({ fullscreen: e.target.checked });
$("s-width").oninput = (e) => set({ width: +e.target.value || 0 });
$("s-height").oninput = (e) => set({ height: +e.target.value || 0 });
$("s-onlaunch").onchange = (e) => set({ onLaunch: e.target.value });
$("s-java").oninput = (e) => set({ javaPath: e.target.value });
$("s-preset").onchange = (e) => set({ jvmPreset: e.target.value });
$("s-jvm").oninput = (e) => set({ jvmArgs: e.target.value });
$("s-startup").onchange = (e) => set({ launchAtStartup: e.target.checked });
$("reset-settings").onclick = async () => { fillSettings(await api.resetSettings()); toast("Ajustes restaurados."); };
$("open-data").onclick = () => api.openData();
$("open-log").onclick = () => api.openLog();
$("java-browse").onclick = async () => { const p = await api.chooseJava(); if (p) { $("s-java").value = p; set({ javaPath: p }); } };
$("java-detect").onclick = async () => {
  const box = $("java-list"); box.textContent = "Procurando…";
  const list = await api.detectJava();
  if (!list.length) return (box.textContent = "Nenhum Java encontrado. Instale o Java 21 (Temurin).");
  box.replaceChildren(...list.map((j) => {
    const b = document.createElement("button"); b.textContent = `Java ${j.major} — ${j.path}`; b.title = j.path;
    b.onclick = () => { $("s-java").value = j.path; set({ javaPath: j.path }); toast(`Java ${j.major} selecionado`); };
    return b;
  }));
};

const UPD_TEXT = {
  checking: () => "Procurando atualizações…",
  downloading: (u) => `Baixando v${u.version}… ${u.percent || 0}%`,
  ready: (u) => `v${u.version} pronta para instalar.`,
  manual: (u) => `Nova versão v${u.version} disponível.`,
  error: (u) => u.message || "Erro ao atualizar.",
};
function showUpdate(u) {
  state.upd = u;
  const box = $("upd"), btn = $("upd-btn");
  const text = UPD_TEXT[u.state]?.(u);
  box.hidden = !text || u.state === "checking";
  box.classList.toggle("err", u.state === "error");
  $("upd-text").textContent = text || "";
  $("upd-bar").hidden = u.state !== "downloading";
  $("upd-fill").style.width = (u.percent || 0) + "%";
  btn.hidden = !["ready", "manual"].includes(u.state);
  btn.textContent = u.state === "ready" ? "Reiniciar e atualizar" : "Baixar atualização";
  const detail = {
    idle: "Ainda não verificado.", checking: "Verificando…", none: "Você está na versão mais recente. ✓",
    dev: "Auto-update só funciona no app instalado (não no npm start).",
  }[u.state] || text || "";
  $("upd-detail").textContent = detail;
  $("upd-check").disabled = ["checking", "downloading"].includes(u.state);
}
$("upd-btn").onclick = () => {
  const u = state.upd;
  if (u.state === "ready") api.installUpdate();
  else if (u.state === "manual") api.openExternal(u.url);
};
$("upd-check").onclick = async () => showUpdate(await api.updateCheck());
api.onUpdate(showUpdate);

(async function init() {
  state.cfg = await api.config();
  document.title = state.cfg.name;
  $("brand-name").textContent = state.cfg.name; $("hero-name").textContent = state.cfg.name;
  $("s-ram").max = state.cfg.maxRam;
  $("about").textContent = `${state.cfg.name} Launcher v${state.cfg.version}`;
  fillSettings(await api.getSettings());
  ramSync(state.s.ramGb);
  showUpdate(await api.updateState());
  setInterval(() => state.session && refreshStatus(), 30000);
  const session = await api.session();
  if (session) enter(session);
})();

const LOOK_DEFAULT = { aurora: false, particles: false, anim: true, compact: false, glass: 80 };
let look = { ...LOOK_DEFAULT };
try { Object.assign(look, JSON.parse(localStorage.getItem("look") || "{}")); } catch {}
function applyLookUI() {
  const r = document.documentElement;
  r.style.setProperty("--glass", look.glass / 100);
  r.classList.toggle("no-aurora", !look.aurora);
  r.classList.toggle("no-particles", !look.particles);
  r.classList.toggle("no-anim", !look.anim);
  r.classList.toggle("compact", look.compact);
  $("s-aurora").checked = look.aurora; $("s-particles").checked = look.particles;
  $("s-anim").checked = look.anim; $("s-compact").checked = look.compact; $("s-glass").value = look.glass;
  fxColor(); moveInd();
}
function setLook(p) { Object.assign(look, p); try { localStorage.setItem("look", JSON.stringify(look)); } catch {} applyLookUI(); }
$("s-aurora").onchange = (e) => setLook({ aurora: e.target.checked });
$("s-particles").onchange = (e) => setLook({ particles: e.target.checked });
$("s-anim").onchange = (e) => setLook({ anim: e.target.checked });
$("s-compact").onchange = (e) => setLook({ compact: e.target.checked });
$("s-glass").oninput = (e) => setLook({ glass: +e.target.value });

function moveInd() {
  const a = document.querySelector("#nav button.active"), ind = $("nav-ind");
  if (a && ind) { ind.style.width = a.offsetWidth + "px"; ind.style.transform = `translateX(${a.offsetLeft}px)`; }
}
new MutationObserver(moveInd).observe($("nav"), { subtree: true, attributes: true, attributeFilter: ["class"] });
setTimeout(moveInd, 50); addEventListener("resize", moveInd);
$("app").addEventListener("animationend", moveInd);

document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest(".solid, .outline, .danger"); if (!b || b.disabled || !look.anim) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) / 4;
  const d = document.createElement("span"); d.className = "ripple";
  d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.append(d); setTimeout(() => d.remove(), 650);
});

const cv = $("fx"), cx = cv.getContext("2d"); let pts = [], fxRGB = "196,181,253";
function fxColor() { fxRGB = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim() || fxRGB; }
function fxResize() {
  cv.width = innerWidth; cv.height = innerHeight;
  pts = Array.from({ length: Math.min(60, Math.floor(innerWidth / 22)) }, () => ({
    x: Math.random() * cv.width, y: Math.random() * cv.height, r: Math.random() * 2 + .6,
    v: Math.random() * .35 + .12, d: Math.random() * 6.28, a: Math.random() * .5 + .15,
  }));
}
function fxTick() {
  requestAnimationFrame(fxTick);
  if (!look.particles || document.hidden) return;
  cx.clearRect(0, 0, cv.width, cv.height);
  for (const p of pts) {
    p.y -= p.v; p.d += .01; p.x += Math.sin(p.d) * .3;
    if (p.y < -5) { p.y = cv.height + 5; p.x = Math.random() * cv.width; }
    cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 6.283);
    cx.fillStyle = `rgba(${fxRGB},${p.a})`; cx.fill();
  }
}
addEventListener("resize", fxResize); fxResize(); applyLookUI(); fxTick();

setTimeout(() => document.documentElement.classList.remove("booting"), 2600);
