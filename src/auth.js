const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const { API_URL: RAW_API_URL } = require("./config");
const API_URL = RAW_API_URL.replace(/\/+$/, "");

const file = () => path.join(app.getPath("userData"), "session.bin");

async function call(route, body) {
  let res;
  try {
    res = await fetch(`${API_URL}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") throw new Error("A API demorou demais pra responder. Tente de novo.");
    throw new Error("Não deu pra conectar na API. Verifique sua internet.");
  }
  if (res.status === 404)
    throw new Error("API não encontrada (404). Confira o API_URL em src/config.js.");
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`A API respondeu algo inesperado (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(data.error || "Erro na autenticação.");
  return data;
}

function save(session) {
  const raw = JSON.stringify(session);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(raw)
    : Buffer.from(raw);
  fs.writeFileSync(file(), buf);
}

function load() {
  try {
    const buf = fs.readFileSync(file());
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function login(username, password) {
  const s = await call("/auth/login", { username, password });
  save(s);
  return s;
}

async function register(username, password) {
  const s = await call("/auth/register", { username, password });
  save(s);
  return s;
}

function logout() {
  try { fs.unlinkSync(file()); } catch {}
}

module.exports = { login, register, logout, load };
