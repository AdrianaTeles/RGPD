// netlify/functions/admin-historico.js
// GET → { historico: [{ data, acao, detalhe, ip }] } (mais recente primeiro, até 50)

import { initStorage, getHistorico } from "./lib/storage.js";
import { requireAuth, json } from "./lib/auth.js";

export const handler = async (event) => {
  initStorage(event);
  const erroAuth = requireAuth(event);
  if (erroAuth) return erroAuth;
  if (event.httpMethod !== "GET") return json(405, { message: "Método não permitido" });

  const historico = (await getHistorico()).slice(0, 50);
  return json(200, { historico });
};
