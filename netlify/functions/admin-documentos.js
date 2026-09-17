// netlify/functions/admin-documentos.js
// GET                             → { documentos: [info...], textos }
// PUT  ?nome=cgv.pdf  (body: PDF) → substitui o documento (guarda a versão anterior)
// POST ?nome=cgv.pdf&acao=repor   → repõe a versão anterior
// PUT  ?textos=1 { textos }       → atualiza textos configuráveis (ex.: validade da CGV)

import {
  initStorage, DOCUMENTOS, TEXTOS_DEFAULT,
  getDocumentoInfo, setDocumento, reporDocumento, getTextos, setTextos, addHistorico,
} from "./lib/storage.js";
import { requireAuth, json, ipDoPedido } from "./lib/auth.js";

// Limite abaixo dos 6MB de payload das Netlify Functions (o body chega em base64, +33%).
const MAX_BYTES = 4 * 1024 * 1024;

function bodyBytes(event) {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "latin1");
}

async function registar(event, acao, detalhe) {
  try { await addHistorico({ acao, detalhe, ip: ipDoPedido(event) }); } catch (e) { console.warn("histórico:", e.message); }
}

export const handler = async (event) => {
  initStorage(event);
  const erroAuth = requireAuth(event);
  if (erroAuth) return erroAuth;

  const q = event.queryStringParameters || {};

  if (event.httpMethod === "GET") {
    const documentos = await Promise.all(Object.keys(DOCUMENTOS).map(getDocumentoInfo));
    const textos = await getTextos();
    return json(200, { documentos, textos, textosDefault: TEXTOS_DEFAULT });
  }

  // ── Textos ────────────────────────────────────────────────────────────────
  if (event.httpMethod === "PUT" && q.textos) {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { message: "JSON inválido" }); }
    const textos = body.textos || {};
    for (const [k, v] of Object.entries(textos)) {
      if (!(k in TEXTOS_DEFAULT)) return json(400, { message: `Texto desconhecido: ${k}` });
      if (typeof v !== "string" || v.trim().length < 3 || v.length > 120) return json(400, { message: `Valor inválido para ${k} (3–120 caracteres).` });
    }
    let gravados;
    try { gravados = await setTextos(textos); } catch (err) {
      console.error("[admin-documentos] erro a gravar textos:", err);
      return json(500, { message: "Erro ao gravar." });
    }
    await registar(event, "textos.atualizar", Object.entries(textos).map(([k, v]) => `${k}="${v.trim()}"`).join("; "));
    return json(200, { ok: true, textos: gravados });
  }

  // ── Documentos ────────────────────────────────────────────────────────────
  const nome = q.nome;
  if (!nome || !DOCUMENTOS[nome]) return json(404, { message: "Documento desconhecido." });
  if (!DOCUMENTOS[nome].editavel) return json(403, { message: DOCUMENTOS[nome].motivo || "Documento não editável." });

  if (event.httpMethod === "PUT") {
    const bytes = bodyBytes(event);
    if (bytes.length === 0) return json(400, { message: "Ficheiro vazio." });
    if (bytes.length > MAX_BYTES) return json(413, { message: `Ficheiro demasiado grande (máx. ${MAX_BYTES / 1024 / 1024} MB).` });
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return json(400, { message: "O ficheiro não é um PDF válido." });

    let documento;
    try {
      documento = await setDocumento(nome, bytes, { ip: ipDoPedido(event) });
    } catch (err) {
      console.error("[admin-documentos] erro a gravar", nome, err);
      return json(500, { message: "Erro ao gravar o documento." });
    }
    console.log("[admin-documentos] substituído:", nome, bytes.length, "bytes");
    await registar(event, "documento.substituir", `${nome} (${(bytes.length / 1024).toFixed(0)} KB)`);
    return json(200, { ok: true, documento });
  }

  if (event.httpMethod === "POST" && q.acao === "repor") {
    let documento;
    try { documento = await reporDocumento(nome); } catch (err) {
      console.error("[admin-documentos] erro a repor", nome, err);
      return json(500, { message: "Erro ao repor o documento." });
    }
    console.log("[admin-documentos] reposto:", nome, "→", documento.origem);
    await registar(event, "documento.repor", `${nome} (agora: ${documento.origem === "bundle" ? "versão original" : "versão anterior"})`);
    return json(200, { ok: true, documento });
  }

  return json(405, { message: "Método não permitido" });
};
