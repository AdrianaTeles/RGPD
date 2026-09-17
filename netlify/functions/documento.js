// netlify/functions/documento.js
// Serve um documento gerido pelo backoffice (ex.: CGV), com fallback para o ficheiro do bundle.
// GET /.netlify/functions/documento?nome=cgv.pdf   (o netlify.toml reescreve /cgv.pdf para aqui)

import { initStorage, getDocumento, DOCUMENTOS } from "./lib/storage.js";

export const handler = async (event) => {
  initStorage(event);
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Método não permitido" };
  }
  const nome = event.queryStringParameters?.nome;
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
