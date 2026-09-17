// netlify/functions/documento.js
// Serve um documento gerido pelo backoffice (ex.: CGV), com fallback para o ficheiro do bundle.
// GET /.netlify/functions/documento?nome=cgv.pdf
// GET /cgv.pdf  → rewrite no netlify.toml para /.netlify/functions/documento/cgv.pdf
//
// O nome vem da query string OU do último segmento do caminho. Num rewrite o Netlify
// não passa a query string definida no `to`, e event.path mantém o caminho original
// (/cgv.pdf) — por isso o caminho é a forma fiável.

import { initStorage, getDocumento, DOCUMENTOS } from "./lib/storage.js";

function nomeDoCaminho(p) {
  const ultimo = String(p || "").split("?")[0].split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(ultimo);
}

export const handler = async (event) => {
  initStorage(event);
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Método não permitido" };
  }
  const nome = event.queryStringParameters?.nome || nomeDoCaminho(event.path);
  if (!nome || !DOCUMENTOS[nome]) {
    return { statusCode: 404, body: "Documento não encontrado" };
  }

  let doc;
  try {
    doc = await getDocumento(nome);
  } catch (err) {
    console.error("Erro ao carregar documento", nome, err);
    return { statusCode: 500, body: "Erro ao carregar o documento" };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${nome}"`,
      // O ficheiro pode mudar a qualquer momento via backoffice — não deixar o browser/CDN guardar.
      "Cache-Control": "no-cache",
      "X-Documento-Origem": doc.origem,
    },
    body: doc.bytes.toString("base64"),
    isBase64Encoded: true,
  };
};
