// netlify/functions/admin-auth.js
// POST   { password }  → inicia sessão (cookie)
// GET                  → verifica se a sessão é válida
// DELETE               → termina sessão

import { initStorage, addHistorico } from "./lib/storage.js";
import { login, logout, requireAuth, json, ipDoPedido } from "./lib/auth.js";

export const handler = async (event) => {
  initStorage(event);

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { message: "JSON inválido" }); }
    const res = await login(event, body.password);
    if (res.statusCode === 200) {
      try { await addHistorico({ acao: "login", ip: ipDoPedido(event) }); } catch (e) { console.warn("histórico:", e.message); }
    }
    return res;
  }

  if (event.httpMethod === "GET") {
    const erro = requireAuth(event);
    return erro || json(200, { ok: true });
  }

  if (event.httpMethod === "DELETE") {
    return logout();
  }

  return json(405, { message: "Método não permitido" });
};
