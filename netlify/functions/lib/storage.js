// netlify/functions/lib/storage.js
//
// Camada única de acesso a dados editáveis pelo backoffice (Netlify Blobs).
//
// Regra de ouro: TODAS as leituras têm fallback para o que existia antes do
// backoffice (env var CONSULTORES_JSON e ficheiros em public/). Assim:
//   - o deploy desta camada não muda nada em produção até alguém usar o backoffice;
//   - se os blobs forem apagados ou o serviço falhar, o formulário continua a funcionar.
// As escritas não têm fallback — se falharem, o backoffice mostra o erro.

import { getStore, connectLambda } from "@netlify/blobs";
import fs from "fs";
import path from "path";

const STORE_CONFIG = "rgpd-config";
const STORE_DOCS   = "rgpd-documentos";
const HISTORICO_MAX = 200;

// Documentos geridos. `editavel: false` bloqueia o upload no backoffice.
// A FIN é bloqueada porque gerar-rgpd.js e fin-preview.js escrevem o nome do
// cliente em coordenadas fixas da página 2 — um layout diferente partiria isso
// silenciosamente. Alterá-la exige ajustar essas coordenadas no código.
export const DOCUMENTOS = {
  "cgv.pdf": {
    titulo: "Condições Gerais de Venda",
    editavel: true,
  },
  "fin.pdf": {
    titulo: "Ficha Informativa Normalizada",
    editavel: false,
    motivo: "O formulário escreve o nome do cliente numa posição fixa da página 2 da FIN. " +
            "Um layout diferente colocaria o nome no sítio errado. Para alterar a FIN, contacte o developer.",
  },
};

// Textos configuráveis usados na geração do PDF, com os valores originais como default.
export const TEXTOS_DEFAULT = {
  cgvValidade: "Válido de 01/01/2025 a 31/12/2026",
};

// ── Inicialização ────────────────────────────────────────────────────────────

/**
 * Obrigatório no início de cada handler. As functions deste projeto usam a assinatura
 * Lambda (handler(event)), e nesse modo o Netlify Blobs só conhece o contexto do site
 * (siteID, token) se lhe passarmos o event. Idempotente e nunca lança: se o contexto não
 * existir (ex.: ambiente local sem `netlify dev`), as leituras caem no fallback.
 */
export function initStorage(event) {
  try {
    if (event && event.blobs) connectLambda(event);
  } catch (err) {
    console.warn("[storage] connectLambda falhou, leituras usarão fallback:", err.message);
  }
}

// ── Helpers internos ─────────────────────────────────────────────────────────

function store(name) {
  // Consistência eventual (a por defeito). A "strong" exigiria o `uncachedEdgeURL`, que o
  // contexto passado às functions com assinatura Lambda não inclui — lança
  // BlobsConsistencyError em produção. Para não depender de reler logo após escrever,
  // as APIs de escrita devolvem o que gravaram em vez de reler dos blobs.
  return getStore(name);
}

// Localiza um ficheiro empacotado com a function (included_files no netlify.toml).
export function getBundlePath(filename) {
  const roots = [
    "/var/task",
    process.env.LAMBDA_TASK_ROOT,
    process.cwd(),
  ].filter(Boolean);
  for (const root of roots) {
    for (const p of [path.join(root, "public", filename), path.join(root, filename)]) {
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error(`Ficheiro não encontrado no bundle: ${filename}`);
}

async function lerJSON(storeName, key) {
  try {
    return await store(storeName).get(key, { type: "json" });
  } catch (err) {
    // Blobs indisponível (ex.: ambiente local sem `netlify dev`) → comporta-se como "não existe".
    console.warn(`[storage] leitura de ${storeName}/${key} falhou, a usar fallback:`, err.message);
    return null;
  }
}

async function escreverJSON(storeName, key, value) {
  await store(storeName).setJSON(key, value);
}

// ── Consultores ──────────────────────────────────────────────────────────────

function parseConsultoresEnv() {
  const raw = process.env.CONSULTORES_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("CONSULTORES_JSON inválido (JSON malformado):", err.message);
    return null;
  }
}

/**
 * Devolve { map, origem } onde map é { codigo: { nome, email } } e origem é
 * "blob" | "env" | "vazio". Normaliza a forma antiga (string = email).
 */
export async function getConsultores() {
  const doBlob = await lerJSON(STORE_CONFIG, "consultores");
  if (doBlob && typeof doBlob === "object") return { map: normalizarConsultores(doBlob), origem: "blob" };

  const doEnv = parseConsultoresEnv();
  if (doEnv && typeof doEnv === "object") return { map: normalizarConsultores(doEnv), origem: "env" };

  return { map: {}, origem: "vazio" };
}

export async function setConsultores(map) {
  await escreverJSON(STORE_CONFIG, "consultores", normalizarConsultores(map));
}

function normalizarConsultores(map) {
  const out = {};
  for (const [code, entry] of Object.entries(map)) {
    if (typeof entry === "string") out[code] = { nome: code, email: entry };
    else if (entry && typeof entry === "object") out[code] = { nome: entry.nome || code, email: entry.email || "" };
  }
  return out;
}

// ── Textos configuráveis ─────────────────────────────────────────────────────

export async function getTextos() {
  const doBlob = await lerJSON(STORE_CONFIG, "textos");
  return { ...TEXTOS_DEFAULT, ...(doBlob || {}) };
}

/** Grava e devolve os textos resultantes (defaults + gravados), sem reler dos blobs. */
export async function setTextos(textos) {
  const atuais = await getTextos();
  const permitidos = {};
  for (const k of Object.keys(TEXTOS_DEFAULT)) {
    const v = typeof textos[k] === "string" ? textos[k].trim() : atuais[k];
    if (v !== TEXTOS_DEFAULT[k]) permitidos[k] = v;
  }
  await escreverJSON(STORE_CONFIG, "textos", permitidos);
  return { ...TEXTOS_DEFAULT, ...permitidos };
}

// ── Documentos (PDFs) ────────────────────────────────────────────────────────

function validarNomeDocumento(nome) {
  if (!DOCUMENTOS[nome]) throw new Error(`Documento desconhecido: ${nome}`);
}

/**
 * Devolve { bytes: Buffer, origem: "blob" | "bundle", metadata }.
 * Nunca lança por causa do blob — cai sempre para o ficheiro do bundle.
 */
export async function getDocumento(nome) {
  validarNomeDocumento(nome);
  try {
    const res = await store(STORE_DOCS).getWithMetadata(nome, { type: "arrayBuffer" });
    if (res && res.data) {
      return { bytes: Buffer.from(res.data), origem: "blob", metadata: res.metadata || {} };
    }
  } catch (err) {
    console.warn(`[storage] leitura do documento ${nome} falhou, a usar bundle:`, err.message);
  }
  const p = getBundlePath(nome);
  return { bytes: fs.readFileSync(p), origem: "bundle", metadata: {} };
}

/** Metadados sem carregar os bytes: { nome, titulo, editavel, motivo?, origem, tamanho, data, temAnterior }. */
export async function getDocumentoInfo(nome) {
  validarNomeDocumento(nome);
  const def = DOCUMENTOS[nome];
  let origem = "bundle", metadata = {}, tamanho = null, temAnterior = false;
  try {
    const s = store(STORE_DOCS);
    const atual = await s.getMetadata(nome);
    if (atual) { origem = "blob"; metadata = atual.metadata || {}; }
    temAnterior = !!(await s.getMetadata(`${nome}.anterior`));
  } catch (err) {
    console.warn(`[storage] metadados de ${nome} indisponíveis:`, err.message);
  }
  if (origem === "bundle") {
    try { tamanho = fs.statSync(getBundlePath(nome)).size; } catch (_) {}
  } else {
    tamanho = metadata.tamanho ?? null;
  }
  return {
    nome, titulo: def.titulo, editavel: def.editavel, motivo: def.motivo,
    origem, tamanho, data: metadata.data || null, temAnterior,
  };
}

/**
 * Substitui o documento. A versão atual (se existir em blob) passa a `<nome>.anterior`
 * para poder ser reposta. Se a versão atual vinha do bundle, não há "anterior" em blob —
 * repor nesse caso significa apagar o blob (volta ao bundle).
 */
export async function setDocumento(nome, bytes, meta = {}) {
  validarNomeDocumento(nome);
  if (!DOCUMENTOS[nome].editavel) throw new Error(`Documento não editável: ${nome}`);
  const s = store(STORE_DOCS);

  const atual = await s.getWithMetadata(nome, { type: "arrayBuffer" });
  if (atual && atual.data) {
    await s.set(`${nome}.anterior`, atual.data, { metadata: atual.metadata || {} });
  }
  const metadata = { tamanho: bytes.length, data: new Date().toISOString(), ...meta };
  await s.set(nome, bytes, { metadata });
  // Info coerente com o que acabou de ser gravado, sem reler (consistência eventual).
  const def = DOCUMENTOS[nome];
  return {
    nome, titulo: def.titulo, editavel: def.editavel, motivo: def.motivo,
    origem: "blob", tamanho: metadata.tamanho, data: metadata.data,
    temAnterior: !!(atual && atual.data),
  };
}

/** Repõe a versão anterior. Devolve a info do documento resultante (sem reler dos blobs). */
export async function reporDocumento(nome) {
  validarNomeDocumento(nome);
  const def = DOCUMENTOS[nome];
  const s = store(STORE_DOCS);
  const anterior = await s.getWithMetadata(`${nome}.anterior`, { type: "arrayBuffer" });
  if (anterior && anterior.data) {
    // Troca: anterior → atual, atual → anterior (permite "desfazer o desfazer").
    const atual = await s.getWithMetadata(nome, { type: "arrayBuffer" });
    const metadata = anterior.metadata || {};
    await s.set(nome, anterior.data, { metadata });
    if (atual && atual.data) await s.set(`${nome}.anterior`, atual.data, { metadata: atual.metadata || {} });
    else await s.delete(`${nome}.anterior`);
    return {
      nome, titulo: def.titulo, editavel: def.editavel, motivo: def.motivo,
      origem: "blob", tamanho: metadata.tamanho ?? null, data: metadata.data || null,
      temAnterior: !!(atual && atual.data),
    };
  }
  // Sem anterior em blob: a versão anterior é a do bundle.
  await s.delete(nome);
  let tamanho = null;
  try { tamanho = fs.statSync(getBundlePath(nome)).size; } catch (_) {}
  return { nome, titulo: def.titulo, editavel: def.editavel, motivo: def.motivo, origem: "bundle", tamanho, data: null, temAnterior: false };
}

// ── Histórico ────────────────────────────────────────────────────────────────

export async function getHistorico() {
  const h = await lerJSON(STORE_CONFIG, "historico");
  return Array.isArray(h) ? h : [];
}

/** Regista uma ação: { data, acao, detalhe, ip }. Mantém as últimas HISTORICO_MAX. */
export async function addHistorico({ acao, detalhe, ip }) {
  const h = await getHistorico();
  h.unshift({ data: new Date().toISOString(), acao, detalhe: detalhe || "", ip: ip || "" });
  await escreverJSON(STORE_CONFIG, "historico", h.slice(0, HISTORICO_MAX));
}

// ── Genérico (usado pelo rate limit do login) ────────────────────────────────

export const kv = {
  get: (key) => lerJSON(STORE_CONFIG, key),
  set: (key, value) => escreverJSON(STORE_CONFIG, key, value),
};
