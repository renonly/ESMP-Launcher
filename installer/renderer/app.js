const $ = (id) => document.getElementById(id);
const api = window.setup;
let page = 0, dir = "", timer = null;

function show(n) {
  page = n;
  document.querySelectorAll(".page").forEach((p) => (p.hidden = +p.dataset.page !== n));
  const step = Math.min(n, 3);
  document.querySelectorAll("#steps li").forEach((li) => {
    const s = +li.dataset.s; li.classList.toggle("on", s === step); li.classList.toggle("done", s < step);
  });
}
document.addEventListener("click", (e) => { const w = e.target.closest("[data-win]"); if (w) api.win(w.dataset.win); });

$("go-1").onclick = () => show(1);
$("back-0").onclick = () => show(0);
$("back-1").onclick = () => show(1);
$("browse").onclick = async () => { const p = await api.chooseDir(); if (p) $("dir").value = p; };

let phase = "download", dl = 0;
function render(v) {
  v = Math.min(100, Math.round(v));
  $("fill").style.width = v + "%"; $("pct").textContent = v + "%";
  $("stage").textContent = v >= 100 ? "Concluído" : phase === "download" ? `Baixando o ESMP… ${Math.round(dl * 100)}%` : v < 92 ? "Instalando e criando atalhos" : "Finalizando";
}
api.onProgress((v) => { dl = v; if (phase === "download") render(v * 60); });
api.onPhase((p) => { phase = p; });
async function run() {
  dir = $("dir").value.trim(); $("dir-error").textContent = "";
  if (!dir) return ($("dir-error").textContent = "Escolha uma pasta.");
  show(2); phase = "download"; dl = 0; render(0);
  let v = 60; clearInterval(timer);
  timer = setInterval(() => { if (phase === "install") { v += (95 - v) * 0.04; render(v); } }, 300);
  const r = await api.install(dir);
  clearInterval(timer);
  if (!r.ok) { $("fail").textContent = r.error; return show(4); }
  render(100);
  setTimeout(() => show(3), 700);
}
$("do-install").onclick = run;
$("retry").onclick = run;
$("finish").onclick = () => ($("run").checked ? api.launch(dir) : api.win("close"));

(async () => { $("dir").value = await api.defaultDir(); setTimeout(() => document.documentElement.classList.remove("booting"), 50); })();
