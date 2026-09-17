// netlify/functions/admin-consultores.js
// GET  → { consultores: { codigo: { nome, email } }, origem }
// PUT  { consultores: { codigo: { nome, email } } } → substitui a lista inteira

import { initStorage, getConsultores, setConsultores, addHistorico } from "./lib/storage.js";
import { requireAuth, json, ipDoPedido } from "./lib/auth.js";

// O código é livre (a agência já usa formatos como "nome.apelido"). Só se garante que
// funciona num URL: sem espaços e com tamanho razoável.
const CODIGO_RE = /^\S{1,64}$/;
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CONSULTORES = 100;

// Devolve { ok: true, map } ou { ok: false, erros: [] }.
function validar(input) {
  const erros = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, erros: ["Formato inválido."] };
  const entradas = Object.entries(input);
  if (entradas.length > MAX_CONSULTORES) erros.push(`Máximo de ${MAX_CONSULTORES} consultores.`);

  const map = {};
  const emails = new Set();
  for (const [codigoRaw, entry] of entradas) {
    const codigo = String(codigoRaw).trim();
    const nome   = String(entry?.nome ?? "").trim();
    const email  = String(entry?.email ?? "").trim().toLowerCase();
    if (!CODIGO_RE.test(codigo)) erros.push(`Código "${codigoRaw}" inválido (sem espaços, até 64 caracteres).`);
    if (!nome || nome.length > 80) erros.push(`Nome em falta ou demasiado longo para "${codigo}".`);
    if (!EMAIL_RE.test(email) || email.length > 254) erros.push(`Email inválido para "${codigo}".`);
    if (map[codigo]) erros.push(`Código "${codigo}" repetido.`);
    if (emails.has(email)) erros.push(`Email "${email}" repetido.`);
    emails.add(email);
    map[codigo] = { nome, email };
  }
  return erros.length ? { ok: false, erros } : { ok: true, map };
}

export const handler = async (event) => {
  initStorage(event);
  const erroAuth = requireAuth(event);
  if (erroAuth) return erroAuth;

  if (event.httpMethod === "GET") {
    const { map, origem } = await getConsultores();
    return json(200, { consultores: map, origem });
  }

  if (event.httpMethod === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { message: "JSON inválido" }); }
    const v = validar(body.consultores);
    if (!v.ok) return json(400, { message: "Dados inválidos.", erros: v.erros });

    const antes = (await getConsultores()).map;
    try {
      await setConsultores(v.map);
    } catch (err) {
      console.error("[admin-consultores] erro a gravar:", err);
      return json(500, { message: "Erro ao gravar. Tente novamente." });
    }

    const adicionados = Object.keys(v.map).filter(c => !antes[c]);
    const removidos   = Object.keys(antes).filter(c => !v.map[c]);
    const alterados   = Object.keys(v.map).filter(c => antes[c] && (antes[c].nome !== v.map[c].nome || antes[c].email !== v.map[c].email));
    const detalhe = [
      adicionados.length ? `adicionados: ${adicionados.join(", ")}` : "",
      removidos.length   ? `removidos: ${removidos.join(", ")}` : "",
      alterados.length   ? `alterados: ${alterados.join(", ")}` : "",
    ].filter(Boolean).join("; ") || "sem alterações";
    console.log("[admin-consultores] atualizado:", detalhe);
    try { await addHistorico({ acao: "consultores.atualizar", detalhe, ip: ipDoPedido(event) }); } catch (e) { console.warn("histórico:", e.message); }

    return json(200, { ok: true, consultores: v.map, origem: "blob" });
  }

  return json(405, { message: "Método não permitido" });
};
