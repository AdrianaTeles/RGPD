// netlify/functions/fin-preview.js
// Serve a FIN com o nome do cliente substituído, para preview no browser.
// GET /.netlify/functions/fin-preview?nome=João+Silva

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fs from "fs";
import path from "path";

function getPdfPath(filename) {
  const candidates = [
    path.join("/var/task/public", filename),
    path.join("/var/task", filename),
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, "public", filename) : null,
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, filename) : null,
    path.join(process.cwd(), "public", filename),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`PDF não encontrado: ${filename}`);
}

async function substituirNomeNaFIN(finPath, nome) {
  const finBytes = fs.readFileSync(finPath);
  const finDoc = await PDFDocument.load(finBytes);
  const helvetica = await finDoc.embedFont(StandardFonts.Helvetica);

  const page = finDoc.getPage(1);
  const { height } = page.getSize(); // 842

  // Coordenadas calculadas a partir do espaço da página (pdf-lib bottom-left).
  // pdftotext reporta: yMin=200.48, yMax=211.48 em espaço top-left do utilizador.
  // Após transformação T1 [1,0,0,-1,0,842]: rectY = 842 - 211.48 = 630.52
  const rectX = 19;
  const rectY = 630;
  const rectW = 350;
  const rectH = 14;
  const textY = 631.5;

  page.drawRectangle({
    x: rectX, y: rectY, width: rectW, height: rectH,
    color: rgb(1, 1, 1), opacity: 1,
  });

  page.drawText(`Nome Cliente: ${nome}`, {
    x: 19.85, y: textY,
    size: 11, font: helvetica,
    color: rgb(0.329, 0.329, 0.329),
  });

  return finDoc.save();
}

export const handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Método não permitido" };
  }

  const nome = event.queryStringParameters?.nome;
  if (!nome || nome.trim().length < 2) {
    return { statusCode: 400, body: "Parâmetro 'nome' em falta ou inválido" };
  }

  let pdfBytes;
  try {
    const finPath = getPdfPath("fin.pdf");
    pdfBytes = await substituirNomeNaFIN(finPath, nome.trim());
  } catch (err) {
    console.error("Erro ao gerar FIN preview:", err);
    return { statusCode: 500, body: "Erro ao gerar FIN: " + err.message };
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="FIN.pdf"`,
    },
    body: Buffer.from(pdfBytes).toString("base64"),
    isBase64Encoded: true,
  };
};
