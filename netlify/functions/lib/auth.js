// netlify/functions/lib/auth.js
//
// Autenticação do backoffice: password partilhada + cookie de sessão assinado (HMAC).
//
// Este é o ÚNICO ficheiro que conhece o mecanismo de login. Para trocar por
// magic-link ou Netlify Identity mais tarde, substitui-se `login` e `requireAuth`
// e o resto do backoffice não muda.
//
// Env vars: ADMIN_PASSWORD (a password), ADMIN_SESSION_SECRET (≥32 chars aleatórios,
// assina o cookie). Se alguma faltar, o backoffice responde 503 — nunca "abre" por defeito.

import crypto from "crypto";
import { kv } from "./storage.js";

const COOKIE_NAME    = "rgpd_admin";
const SESSAO_SEGUNDOS = 8 * 60 * 60;   // 8h
const LOGIN_MAX_TENTATIVAS = 5;
const LOGIN_JANELA_MS      = 15 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function configurado() {
  return !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET
            && process.env.ADMIN_SESSION_SECRET.length >= 32);
}

function assinar(payload) {
  return crypto.createHmac("sha256", process.env.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
}

// Comparação em tempo constante mesmo com comprimentos diferentes (compara os hashes).
function iguais(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function lerCookie(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || "";
  for (const parte of raw.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=");
  }
  return null;
}

export function ipDoPedido(event) {
  return event.headers?.["x-nf-client-connection-ip"]
      || (event.headers?.["x-forwarded-for"] || "").split(",")[0].trim()
      || "desconhecido";
}

function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

// ── Rate limit (por IP, guardado em blob) ────────────────────────────────────

async function tentativas(ip) {
  const t = await kv.get(`login-tentativas:${ip}`);
  if (!t || Date.now() - t.desde > LOGIN_JANELA_MS) return { n: 0, desde: Date.now() };
  return t;
}

async function registarFalha(ip) {
  const t = await tentativas(ip);
  await kv.set(`login-tentativas:${ip}`, { n: t.n + 1, desde: t.desde });
}

async function limparFalhas(ip) {
  await kv.set(`login-tentativas:${ip}`, { n: 0, desde: Date.now() });
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Valida a password e devolve a resposta HTTP (200 com Set-Cookie, ou erro).
 */
export async function login(event, password) {
  if (!configurado()) {
    console.error("[auth] ADMIN_PASSWORD / ADMIN_SESSION_SECRET em falta ou secret demasiado curto");
    return json(503, { message: "Backoffice não configurado. Contacte o developer." });
  }

  const ip = ipDoPedido(event);
  const t = await tentativas(ip);
  if (t.n >= LOGIN_MAX_TENTATIVAS) {
    const minutos = Math.ceil((LOGIN_JANELA_MS - (Date.now() - t.desde)) / 60000);
    console.warn("[auth] rate limit atingido", { ip });
    return json(429, { message: `Demasiadas tentativas. Tente novamente dentro de ${minutos} min.` });
  }

  if (typeof password !== "string" || !iguais(password, process.env.ADMIN_PASSWORD)) {
    await registarFalha(ip);
    console.warn("[auth] login falhado", { ip, tentativa: t.n + 1 });
    return json(401, { message: "Password incorreta." });
  }

  await limparFalhas(ip);
  const exp = Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS;
  const token = `${exp}.${assinar(String(exp))}`;
  console.log("[auth] login ok", { ip });
  return json(200, { ok: true, expira: new Date(exp * 1000).toISOString() }, {
    "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSAO_SEGUNDOS}`,
  });
}

export function logout() {
  return json(200, { ok: true }, {
    "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  });
}

/**
 * Verifica a sessão. Devolve null se válida, ou uma resposta HTTP de erro para
 * devolver diretamente. Uso: `const erro = requireAuth(event); if (erro) return erro;`
 */
export function requireAuth(event) {
  if (!configurado()) return json(503, { message: "Backoffice não configurado." });

  const token = lerCookie(event);
  if (!token) return json(401, { message: "Sessão em falta." });

  const [expStr, assinatura] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !assinatura || !iguais(assinatura, assinar(expStr))) {
    return json(401, { message: "Sessão inválida." });
  }
  if (exp < Math.floor(Date.now() / 1000)) return json(401, { message: "Sessão expirada." });

  // Defesa extra contra CSRF em pedidos que alteram dados: o Origin tem de ser o próprio site.
  if (["POST", "PUT", "DELETE"].includes(event.httpMethod)) {
    const origin = event.headers?.origin;
    const host   = event.headers?.host;
    if (origin && host && !origin.endsWith(`//${host}`)) {
      return json(403, { message: "Origem do pedido não permitida." });
    }
  }
  return null;
}

export { json };
