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

3. Clica **Save** e depois faz **Trigger deploy** para o site recarregar com as variáveis.

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
