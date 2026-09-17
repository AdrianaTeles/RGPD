// netlify/functions/gerar-rgpd.js
// Gera PDF com RGPD + FIN + CGV preenchidos e envia por email ao cliente e à agência.

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { initStorage, getConsultores, getDocumento, getTextos } from "./lib/storage.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// FIX BUG 1: Não usar import.meta.url — o esbuild destrói-o no bundle Netlify.
// Netlify Functions correm em /var/task; fallback para process.cwd().
function getBaseDir() {
  const candidates = [
    process.env.LAMBDA_TASK_ROOT,
    "/var/task",
    process.cwd(),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(path.join(p, "public"))) return p;
  }
  return process.cwd();
}

function getPdfPath(filename) {
  // Com included_files no netlify.toml, os ficheiros ficam em /var/task/public/
  // Listar todos os caminhos possíveis, incluindo o diretório do próprio bundle
  const candidates = [
    path.join("/var/task/public", filename),
    path.join("/var/task", filename),
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, "public", filename) : null,
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, filename) : null,
    path.join(process.cwd(), "public", filename),
    path.join(process.cwd(), filename),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Debug: listar o que existe em /var/task para diagnóstico
  try {
    const taskContents = fs.readdirSync("/var/task");
    console.error("Conteúdo de /var/task:", taskContents);
    if (taskContents.includes("public")) {
      console.error("Conteúdo de /var/task/public:", fs.readdirSync("/var/task/public"));
    }
  } catch (e) { console.error("Erro ao listar /var/task:", e.message); }

  throw new Error(`PDF não encontrado: ${filename}. cwd=${process.cwd()} LAMBDA_TASK_ROOT=${process.env.LAMBDA_TASK_ROOT}`);
}

function getLogoPath() {
  const base = getBaseDir();
  const candidates = [
    path.join(base, "public/logo.png"),
    path.join("/var/task/public/logo.png"),
    path.join(process.cwd(), "public/logo.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function dataPortugues(date = new Date()) {
  const meses = [
    "janeiro","fevereiro","março","abril","maio","junho",
    "julho","agosto","setembro","outubro","novembro","dezembro",
  ];
  return `${date.getDate()} de ${meses[date.getMonth()]} de ${date.getFullYear()}`;
}

function horaFormatada(date = new Date()) {
  return date.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

// Resolve o código de consultor (vindo do URL ?c=codigo) para { code, nome, email }.
// A lista vem de storage.getConsultores() (backoffice/blob, com fallback para a env var
// CONSULTORES_JSON). Qualquer problema (código desconhecido, email inválido) devolve null
// e o fluxo segue sem consultor — nunca bloqueia o consentimento do cliente.
async function resolveConsultor(code) {
  if (!code || typeof code !== "string") return null;

  const { map, origem } = await getConsultores();
  const entry = map[code];
  if (!entry) {
    console.warn("Consultor não encontrado no mapping (origem:", origem + "):", code);
    return null;
  }

  const email = entry.email;
  const nome  = entry.nome || code;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Email do consultor inválido para", code, ":", email);
    return null;
  }
  return { email, nome, code };
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Substituir nome na FIN ────────────────────────────────────────────────────
// A FIN tem "1 0 0 -1 0 842 cm" (Y-flip Google Docs) no content stream.
// Desenhar directamente na página loaded não é fiável — o pdf-lib appenda
// operadores mas a transformação da stream original afecta a posição.
//
// SOLUÇÃO: copiar todas as páginas para um doc novo (copyPages),
// e só então desenhar o overlay na página 2 copiada.
// As páginas copiadas ficam em espaço limpo — drawRectangle/drawText
// operam em coordenadas de página (bottom-left) sem interferência do CTM original.
//
// Coordenadas verificadas com pdfminer:
//   "Nome Cliente: Sofia Dias dos Santos" → bbox (19.85, 630.52, 186.03, 641.52)
async function substituirNomeNaFIN(finPath, nome) {
  const finBytes = fs.readFileSync(finPath);
  const finDoc = await PDFDocument.load(finBytes, { ignoreEncryption: true });

  // Copiar todas as páginas para um doc novo — resolve o problema do CTM
  const newDoc = await PDFDocument.create();
  const pages  = await newDoc.copyPages(finDoc, finDoc.getPageIndices());
  pages.forEach(p => newDoc.addPage(p));

  // Na página 2 (índice 1): cobrir o nome antigo e escrever o novo
  const page2    = newDoc.getPage(1);
  const helvetica = await newDoc.embedFont(StandardFonts.Helvetica);

  page2.drawRectangle({
    x: 18, y: 628, width: 420, height: 18,
    color: rgb(1, 1, 1), opacity: 1,
  });

  page2.drawText(`Nome Cliente: ${nome}`, {
    x: 19.85, y: 631,
    size: 11, font: helvetica,
    color: rgb(0.329, 0.329, 0.329),
  });

  return newDoc.save();
}

// ── Gerador de PDF ────────────────────────────────────────────────────────────

async function gerarPDF({ nome, doc, email, marketing, dataHora, consultor }) {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const navy  = rgb(0.10, 0.23, 0.36);
  const blue  = rgb(0.12, 0.44, 0.66);
  const black = rgb(0.10, 0.15, 0.19);
  const grey  = rgb(0.42, 0.50, 0.56);
  const white = rgb(1, 1, 1);
  const lightBg = rgb(0.97, 0.98, 0.99);

  // ── Página de Comprovativo ──────────────────────────────────────────────────
  const capa = pdfDoc.addPage([595, 842]);
  const { width, height } = capa.getSize();
  const margin = 56;
  const inner  = width - margin * 2;

  capa.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: white });

  const logoPath = getLogoPath();
  if (logoPath) {
    try {
      const logoBytes = fs.readFileSync(logoPath);
      const logoPng   = await pdfDoc.embedPng(logoBytes);
      const logoDims  = logoPng.scaleToFit(160, 46);
      capa.drawImage(logoPng, { x: margin, y: height - 66, width: logoDims.width, height: logoDims.height });
    } catch (_) {
      capa.drawText("lusotravel", { x: margin, y: height - 52, size: 22, font: fontBold, color: navy });
    }
  } else {
    capa.drawText("lusotravel", { x: margin, y: height - 52, size: 22, font: fontBold, color: navy });
  }

  capa.drawRectangle({ x: 0, y: height - 82, width, height: 3, color: blue });

  let y = height - 122;
  capa.drawText("Registo de Consentimentos — RGPD", { x: margin, y, size: 16, font: fontBold, color: navy });
  y -= 6;
  capa.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.8, color: rgb(0.75, 0.85, 0.93) });

  y -= 12;
  const boxH = consultor ? 141 : 122;
  capa.drawRectangle({ x: margin, y: y - (boxH - 14), width: inner, height: boxH, color: lightBg, borderColor: rgb(0.82,0.88,0.94), borderWidth: 1 });
  y -= 6;

  const drawRow = (label, value, yPos) => {
    capa.drawText(label, { x: margin + 12, y: yPos, size: 9, font: fontBold, color: grey });
    capa.drawText(value || "—", { x: margin + 175, y: yPos, size: 9, font: fontRegular, color: black });
    return yPos - 19;
  };
  y = drawRow("Nome completo:", nome, y);
  y = drawRow("Nº CC / Passaporte:", doc, y);
  y = drawRow("Email:", email, y);
  y = drawRow("Data:", dataPortugues(dataHora), y);
  y = drawRow("Hora (UTC):", horaFormatada(dataHora), y);
  if (consultor) {
    y = drawRow("Consultor responsável:", consultor.nome, y);
  }
  y -= 10;

  const drawCheck = (text, yPos) => {
    // Caixa azul preenchida — alinhada com a primeira linha de texto
    capa.drawRectangle({ x: margin, y: yPos - 1, width: 10, height: 10, color: blue });
    // Visto
    capa.drawLine({ start: { x: margin + 2, y: yPos + 3 }, end: { x: margin + 4.5, y: yPos + 1 }, thickness: 1.5, color: white });
    capa.drawLine({ start: { x: margin + 4.5, y: yPos + 1 }, end: { x: margin + 8.5, y: yPos + 7 }, thickness: 1.5, color: white });
    // Texto começa na mesma altura que a checkbox
    const lines = wrapText(text, fontRegular, 9, inner - 22);
    let ly = yPos + 7;
    lines.forEach(line => {
      capa.drawText(line, { x: margin + 16, y: ly, size: 9, font: fontRegular, color: black });
      ly -= 13;
    });
    // Espaço extra entre cada item
    return ly - 8;
  };

  const drawSection = (titulo, yPos) => {
    capa.drawText(titulo, { x: margin, y: yPos, size: 10.5, font: fontBold, color: navy });
    yPos -= 5;
    capa.drawLine({ start: { x: margin, y: yPos }, end: { x: width - margin, y: yPos }, thickness: 0.5, color: rgb(0.8, 0.88, 0.94) });
    return yPos - 14;
  };

  y = drawSection("Declarações confirmadas", y);
  y = drawCheck("Li e aceito as Condições Gerais de Venda da Lusotravel.", y);
  y = drawCheck("Li a Ficha Informativa Normalizada e confirmo que todos os participantes têm conhecimento e aceitam as condições pré-contratuais.", y);
  y = drawCheck("Consinto o tratamento dos meus dados pessoais pela Lusotravel, NIF 517 395 673, nos termos do RGPD (UE) 2016/679, no âmbito da reserva efetuada.", y);
  if (marketing) {
    y = drawCheck("Consinto o envio de comunicações de marketing relativas a promoções e oportunidades de viagens pela Lusotravel.", y);
  }
  y -= 8;

  y = drawSection("Direitos reconhecidos", y);
  for (const d of [
    "Retirar o meu consentimento relativamente ao seu tratamento;",
    "Opor-me à continuação do seu tratamento;",
    "Solicitar o acesso, retificação ou eliminação (incluindo o direito ao esquecimento);",
    "Solicitar a sua portabilidade.",
  ]) {
    capa.drawText("·", { x: margin, y, size: 12, font: fontBold, color: blue });
    const lines = wrapText(d, fontRegular, 9, inner - 18);
    let ly = y;
    lines.forEach(l => { capa.drawText(l, { x: margin + 12, y: ly, size: 9, font: fontRegular, color: black }); ly -= 13; });
    y = ly - 2;
  }
  y -= 8;

  y = drawSection("A Lusotravel compromete-se a:", y);
  for (const c of [
    "Proteger os dados pessoais por medidas de segurança técnica e organizacional;",
    "Utilizar os dados exclusivamente com as finalidades previstas;",
    "Assegurar o dever de sigilo e confidencialidade;",
    "Proceder à eliminação dos dados quando deixarem de ser necessários.",
  ]) {
    capa.drawText("·", { x: margin, y, size: 12, font: fontBold, color: blue });
    const lines = wrapText(c, fontRegular, 9, inner - 18);
    let ly = y;
    lines.forEach(l => { capa.drawText(l, { x: margin + 12, y: ly, size: 9, font: fontRegular, color: black }); ly -= 13; });
    y = ly - 2;
  }

  y -= 18;
  capa.drawLine({ start: { x: margin, y }, end: { x: margin + 220, y }, thickness: 0.8, color: black });
  capa.drawText(nome, { x: margin, y: y - 13, size: 9, font: fontBold, color: black });
  capa.drawText(`Assinatura digital · ${dataPortugues(dataHora)}, ${horaFormatada(dataHora)}`, { x: margin, y: y - 25, size: 7.5, font: fontRegular, color: grey });

  capa.drawRectangle({ x: 0, y: 0, width, height: 32, color: lightBg });
  capa.drawLine({ start: { x: 0, y: 32 }, end: { x: width, y: 32 }, thickness: 0.5, color: rgb(0.8, 0.88, 0.94) });
  capa.drawText("Lusotravel · PJM Unipessoal Lda · NIF 517 395 673 · RNAVT 12113 · geral@lusotravel.pt · 932 878 377", { x: margin, y: 13, size: 7.5, font: fontRegular, color: grey });
  capa.drawText(`Documento gerado automaticamente em ${dataPortugues(dataHora)} às ${horaFormatada(dataHora)}`, { x: margin, y: 3, size: 7, font: fontRegular, color: rgb(0.6, 0.7, 0.75) });

  // ── FIN com nome substituído ──────────────────────────────────────────────
  const finOrigPath = getPdfPath("fin.pdf");
  // Sem try/catch aqui — se falhar, o erro sobe até ao handler e aparece nos logs
  console.log("A substituir nome na FIN:", nome, "| ficheiro:", finOrigPath);
  const finBytes = await substituirNomeNaFIN(finOrigPath, nome);
  console.log("FIN processada, tamanho:", finBytes.length);

  const addSeparator = async (titulo, subtitulo) => {
    const sep = pdfDoc.addPage([595, 842]);
    sep.drawRectangle({ x: 0, y: 842 - 80, width: 595, height: 80, color: white });
    if (logoPath) {
      try {
        const lb = fs.readFileSync(logoPath);
        const lp = await pdfDoc.embedPng(lb);
        const ld = lp.scaleToFit(140, 40);
        sep.drawImage(lp, { x: 56, y: 842 - 64, width: ld.width, height: ld.height });
      } catch (_) {}
    }
    sep.drawRectangle({ x: 0, y: 842 - 82, width: 595, height: 3, color: blue });
    sep.drawText(titulo, { x: 56, y: 842 - 150, size: 17, font: fontBold, color: navy });
    if (subtitulo) sep.drawText(subtitulo, { x: 56, y: 842 - 175, size: 11, font: fontRegular, color: grey });
  };

  await addSeparator("Ficha Informativa Normalizada (FIN)", `Cliente: ${nome} · ${dataPortugues(dataHora)}`);
  const finDoc   = await PDFDocument.load(finBytes);
  const finPages = await pdfDoc.copyPages(finDoc, finDoc.getPageIndices());
  finPages.forEach(p => pdfDoc.addPage(p));

  // ── CGV ───────────────────────────────────────────────────────────────────
  const textos = await getTextos();
  const cgv    = await getDocumento("cgv.pdf");
  console.log("CGV carregada (origem:", cgv.origem + ", tamanho:", cgv.bytes.length + ")");
  await addSeparator("Condições Gerais de Venda", textos.cgvValidade);
  const cgvDoc   = await PDFDocument.load(cgv.bytes);
  const cgvPages = await pdfDoc.copyPages(cgvDoc, cgvDoc.getPageIndices());
  cgvPages.forEach(p => pdfDoc.addPage(p));

  return pdfDoc.save();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  initStorage(event);
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ message: "Método não permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: "JSON inválido" }) };
  }

  const { nome, doc, email, marketing, consultor: consultorCode } = body;

  if (!nome || !doc || !email) {
    return { statusCode: 400, body: JSON.stringify({ message: "Campos obrigatórios em falta" }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ message: "Email inválido" }) };
  }

  const consultor = await resolveConsultor(consultorCode);
  if (consultor) {
    console.log("Consultor resolvido:", consultor.code, "→", consultor.email);
  } else if (consultorCode) {
    console.log("Código de consultor recebido mas não resolvido:", consultorCode);
  }

  const dataHora = new Date();

  let pdfBytes;
  try {
    pdfBytes = await gerarPDF({ nome, doc, email, marketing: !!marketing, dataHora, consultor });
  } catch (err) {
    console.error("Erro ao gerar PDF:", err);
    return { statusCode: 500, body: JSON.stringify({ message: "Erro ao gerar o PDF: " + err.message }) };
  }

  const pdfBase64 = Buffer.from(pdfBytes).toString("base64");
  const filename  = `RGPD_${nome.replace(/\s+/g, "_")}_${dataHora.toISOString().split("T")[0]}.pdf`;

  const resend = new Resend(process.env.RESEND_API_KEY);

  // NOTA: EMAIL_FROM deve ser um domínio verificado no Resend
  // Formato: "Nome <email@dominio.pt>" ou "email@dominio.pt"
  const fromAddr = process.env.EMAIL_FROM || "Lusotravel <noreply@lusotravel.pt>";

  // Resend SDK: "to" como array, "content" do anexo em base64 string
  const emailCliente = {
    from: fromAddr,
    to:   [email],
    subject: "Os seus consentimentos RGPD · Lusotravel",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #dae4ef;border-radius:6px;overflow:hidden">
        <div style="background:#fff;padding:20px 28px;border-bottom:3px solid #1e6fa8">
          <span style="font-size:20px;font-weight:700;color:#1a3a5c;letter-spacing:1px">lusotravel</span>
          <span style="font-size:11px;color:#6a8090;font-style:italic;margin-left:8px">Creating Memorable Moments</span>
        </div>
        <div style="padding:28px 28px;background:#fff">
          <p style="font-size:15px;color:#1a2530">Olá <strong>${nome}</strong>,</p>
          <p style="font-size:14px;color:#3a4a5a;line-height:1.65">Em anexo encontra o documento completo com o registo dos seus consentimentos, incluindo a Ficha Informativa Normalizada e as Condições Gerais de Venda.</p>
          <p style="font-size:13px;color:#6a8090;margin-top:20px">Qualquer questão, contacte-nos em <a href="mailto:geral@lusotravel.pt" style="color:#1e6fa8">geral@lusotravel.pt</a> ou 932 878 377.</p>
        </div>
        <div style="padding:14px 28px;background:#f7f9fc;border-top:1px solid #dae4ef;text-align:center">
          <p style="font-size:11px;color:#8a9aaa;margin:0">Lusotravel · PJM Unipessoal Lda · NIF 517 395 673 · RNAVT 12113</p>
        </div>
      </div>`,
    attachments: [{ filename, content: pdfBase64 }],
  };

  // Agência recebe sempre; o consultor (se resolvido) recebe cópia. Set evita duplicar
  // quando o email do consultor coincide com EMAIL_AGENCIA.
  const emailAgenciaAddr = process.env.EMAIL_AGENCIA || "geral@lusotravel.pt";
  const destinatariosAgencia = [...new Set([emailAgenciaAddr, consultor?.email].filter(Boolean))];

  const emailAgencia = {
    from: fromAddr,
    to:   destinatariosAgencia,
    subject: consultor
      ? `[RGPD] Novo consentimento — ${nome} (consultor: ${consultor.nome})`
      : `[RGPD] Novo consentimento — ${nome}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #dae4ef;border-radius:6px;overflow:hidden">
        <div style="background:#1a3a5c;padding:16px 24px">
          <span style="color:#fff;font-weight:700;font-size:15px">Novo registo de consentimento RGPD</span>
        </div>
        <div style="padding:22px 24px;background:#fff">
          <table style="width:100%;font-size:13px;border-collapse:collapse">
            <tr style="border-bottom:1px solid #eef2f6"><td style="padding:8px 0;color:#6a8090;width:150px">Nome</td><td style="padding:8px 0;font-weight:700">${nome}</td></tr>
            <tr style="border-bottom:1px solid #eef2f6"><td style="padding:8px 0;color:#6a8090">CC / Passaporte</td><td style="padding:8px 0">${doc}</td></tr>
            <tr style="border-bottom:1px solid #eef2f6"><td style="padding:8px 0;color:#6a8090">Email</td><td style="padding:8px 0">${email}</td></tr>
            <tr style="border-bottom:1px solid #eef2f6"><td style="padding:8px 0;color:#6a8090">Marketing</td><td style="padding:8px 0">${marketing ? "✅ Sim" : "❌ Não"}</td></tr>
            ${consultor ? `<tr style="border-bottom:1px solid #eef2f6"><td style="padding:8px 0;color:#6a8090">Consultor</td><td style="padding:8px 0;font-weight:700">${consultor.nome} &lt;${consultor.email}&gt;</td></tr>` : ""}
            <tr><td style="padding:8px 0;color:#6a8090">Data / Hora</td><td style="padding:8px 0">${dataPortugues(dataHora)}, ${horaFormatada(dataHora)}</td></tr>
          </table>
        </div>
      </div>`,
    attachments: [{ filename, content: pdfBase64 }],
  };

  try {
    // Envio sequencial para identificar qual email falha nos logs do Netlify
    const r1 = await resend.emails.send(emailCliente);
    if (r1.error) {
      console.error("Erro email cliente:", JSON.stringify(r1.error));
      throw new Error("Falha email cliente: " + (r1.error.message || JSON.stringify(r1.error)));
    }
    console.log("Email cliente enviado, id:", r1.data?.id);

    const r2 = await resend.emails.send(emailAgencia);
    if (r2.error) {
      console.error("Erro email agência:", JSON.stringify(r2.error));
      throw new Error("Falha email agência: " + (r2.error.message || JSON.stringify(r2.error)));
    }
    console.log("Email agência enviado, id:", r2.data?.id);
  } catch (err) {
    console.error("Erro ao enviar emails:", err);
    return { statusCode: 500, body: JSON.stringify({ message: "PDF gerado mas erro ao enviar email: " + err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ message: "ok" }) };
};
