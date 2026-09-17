# RGPD Lusotravel — Formulário de Consentimentos

Formulário web que:
1. Pede ao cliente nome, nº CC/Passaporte e email
2. Mostra os PDFs da FIN e Condições Gerais para consulta
3. Recolhe 3 consentimentos obrigatórios + 1 opcional (marketing)
4. Gera um PDF com todos os documentos e envia por email ao cliente e à agência

---

## Estrutura do projeto

```
├── public/
│   ├── index.html       ← formulário
│   ├── cgv.pdf          ← Condições Gerais de Venda
│   ├── fin.pdf          ← Ficha Informativa Normalizada
│   └── rgpd.pdf         ← RGPD original (referência)
├── netlify/
│   └── functions/
│       └── gerar-rgpd.js  ← gera PDF + envia emails
├── .env.example
├── .gitignore
├── netlify.toml
└── package.json
```

---

## Deploy passo a passo

### 1. Pré-requisitos

- Conta GitHub: https://github.com
- Conta Netlify (gratuita): https://netlify.com
- Conta Resend (gratuita): https://resend.com

---

### 2. Configurar o Resend

1. Cria conta em https://resend.com
2. Vai a **Domains** → **Add Domain** → adiciona `lusotravel.pt`
3. Segue as instruções para verificar o domínio (adicionar registos DNS)
4. Vai a **API Keys** → **Create API Key** → copia a chave (começa com `re_`)

> **Para testes sem domínio verificado:** podes usar `from: "onboarding@resend.dev"` e o email só chegará ao teu próprio email Resend.

---

### 3. Fazer upload para o GitHub

```bash
# No terminal, dentro da pasta do projeto:
git init
git add .
git commit -m "Formulário RGPD Lusotravel"

# Cria um repositório novo em github.com e depois:
git remote add origin https://github.com/SEU_USERNAME/rgpd-lusotravel.git
git push -u origin main
```

---

### 4. Deploy no Netlify

1. Entra em https://app.netlify.com
2. Clica **Add new site** → **Import an existing project**
3. Liga ao GitHub e seleciona o repositório `rgpd-lusotravel`
4. Configurações de build:
   - **Build command:** *(deixa vazio)*
   - **Publish directory:** `public`
5. Clica **Deploy site**

---

### 5. Configurar variáveis de ambiente no Netlify

1. No painel do site → **Site configuration** → **Environment variables**
2. Adiciona as seguintes variáveis:

| Variável | Valor |
|---|---|
| `RESEND_API_KEY` | `re_xxxxxxxxxxxxxxxxxxxx` |
| `EMAIL_FROM` | `Lusotravel <noreply@lusotravel.pt>` |
| `EMAIL_AGENCIA` | `geral@lusotravel.pt` |
| `CONSULTORES_JSON` | `{"joana":{"nome":"Joana Silva","email":"joana@lusotravel.pt"}}` (opcional, ver abaixo) |
| `ADMIN_PASSWORD` | password do backoffice (ver secção Backoffice) |
| `ADMIN_SESSION_SECRET` | ≥32 caracteres aleatórios (`openssl rand -base64 48`) |

3. Clica **Save** e depois faz **Trigger deploy** para o site recarregar com as variáveis.

---

### Consultores (links personalizados)

Cada consultor pode ter um link próprio do formulário: `https://<site>/?c=<codigo>`.
Quando um cliente submete o formulário por esse link:

- o consultor recebe cópia do email que vai para a agência (a agência recebe sempre);
- o nome do consultor fica registado na capa do PDF e no assunto do email.

O cliente nunca vê nem escolhe o consultor — o código vai apenas no URL.

A lista gere-se no **backoffice** (ver abaixo). A variável `CONSULTORES_JSON` (JSON numa só linha,
código → consultor) continua a funcionar como valor inicial/fallback enquanto o backoffice
nunca tiver guardado a lista:

```json
{"joana":{"nome":"Joana Silva","email":"joana@lusotravel.pt"},"pedro":"pedro@lusotravel.pt"}
```

Se o código não existir, o formulário funciona na mesma sem consultor (fica um aviso nos logs).

---

### Backoffice (`/admin.html`)

Página para a agência gerir, sem developer nem novo deploy:

- **Consultores** — adicionar/remover; cada um mostra o link `?c=codigo` para copiar.
- **Documentos** — substituir a CGV (PDF até 4 MB). A versão anterior fica guardada e pode ser
  reposta com um clique. A **FIN não é editável** no backoffice: o código escreve o nome do
  cliente numa posição fixa da página 2, e um layout diferente partiria isso silenciosamente.
  Para alterar a FIN, substituir `public/fin.pdf` e rever as coordenadas em `fin-preview.js`
  e `gerar-rgpd.js` (`substituirNomeNaFIN`).
- **Texto de validade da CGV** — o subtítulo da página separadora no PDF final.
- **Histórico** — últimas ações (data, ação, detalhe, IP).

**Onde ficam os dados:** [Netlify Blobs](https://docs.netlify.com/blobs/overview/), nos stores
`rgpd-config` (consultores, textos, histórico) e `rgpd-documentos` (PDFs e versões anteriores).
Todas as leituras têm fallback para o que existia antes (env var e ficheiros em `public/`), por
isso apagar os blobs no dashboard do Netlify repõe o comportamento original.

**Login:** password partilhada (`ADMIN_PASSWORD`), sessão de 8h em cookie assinado
(`ADMIN_SESSION_SECRET`), 5 tentativas falhadas por IP bloqueiam 15 min. Quando alguém sair da
agência, muda a password no Netlify e faz **Trigger deploy**. O mecanismo de login está isolado
em `netlify/functions/lib/auth.js` — trocar por login individual (magic-link por email) só toca
nesse ficheiro.

**Dívida técnica conhecida:** não há testes automatizados das functions; validar em deploy
preview antes de publicar.

---

### 6. Adicionar o logo da Lusotravel

No `public/index.html`, linha do `<img>`, substitui o `src` pelo URL do logo:

```html
<img src="URL_DO_LOGO_AQUI" alt="Lusotravel" />
```

Podes hospedar a imagem no próprio repositório em `public/logo.png` e usar `src="logo.png"`.

---

## Testar localmente

```bash
npm install
npm install -g netlify-cli

# Cria o ficheiro .env (copia o .env.example e preenche)
cp .env.example .env

netlify dev
# Abre http://localhost:8888
```

---

## Atualizar os PDFs

Substitui os ficheiros em `public/`:
- `cgv.pdf` — Condições Gerais de Venda
- `fin.pdf` — Ficha Informativa Normalizada
- `rgpd.pdf` — Documento RGPD original

Faz commit e push — o Netlify faz deploy automaticamente.

---

## Suporte

geral@lusotravel.pt · 932 878 377
