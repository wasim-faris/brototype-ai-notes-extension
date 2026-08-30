# 📚 Brototype AI Notes

A Chrome extension that reads your Brototype task page, writes complete beginner study notes with
AI, and builds an organised page in **your own Notion** — with 5 reviewer questions per task.

```
Brototype task page
      ↓  extension reads the numbered task list (only when you open the panel on that page)
Chrome extension ──→  YOUR AI provider (OpenRouter by default; Gemini, OpenAI, Claude, Grok, custom)
      ↓               with YOUR API key, stored only in your Chrome profile, sent only to that provider
      ↓  structured notes come back
Chrome extension
      ↓  writes pages with YOUR Notion token (stored only in your Chrome profile)
Your Notion workspace

Shared backend (Render): Notion OAuth code → token exchange ONLY. Holds the Notion client secret,
no AI key, no user data.
```

One published extension, one tiny shared backend, and every user's **own** Notion account, **own**
AI key and **own** notes. The backend keeps no user data: no accounts, no sessions, no tokens, no
database — and it never sees an AI key.

- **[PRIVACY.md](PRIVACY.md)** — exactly what data goes where. Host it and link it from the Web Store listing.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — why it is built this way and what the AI is and is not allowed to decide.
- This file — setup, deployment and operations.

---

## 1. Architecture

| Part | Where it runs | What it holds |
|---|---|---|
| `extension/` | Each user's Chrome | That user's **AI provider key(s)**, Notion OAuth token, chosen destination page, settings, the current run. All in `chrome.storage.local` (per profile, unreadable by websites). |
| `backend/` | One Render web service | `NOTION_OAUTH_CLIENT_SECRET` only. **No AI key, nothing per user.** |
| Notion | notion.so | The generated pages, in the user's workspace, created by the user's own connection. |

**AI request flow (direct mode, the only mode a published build offers):**
`service worker → https://<provider>/…` with `Authorization: Bearer <user's key>` (Gemini:
`x-goog-api-key`, Claude: `x-api-key`) — the same adapter code for every provider
(`extension/src/ai/*`). The backend is not on the path. Keys are never put in URLs, never logged
(the job log records counts and titles), and never bundled.

The backend has these endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{ ok: true, aiConfigured, notionOAuth, providers }` — Render's health check. `aiConfigured` is `false` in production, and that is correct. |
| `GET /notion/oauth/config` + `POST /notion/oauth/exchange` (+ `/refresh`) | Notion is a *confidential-client* OAuth flow (HTTP Basic `client_id:client_secret`, no PKCE), so the code→token swap must happen where the secret is. The token goes straight back to that user's extension and is not kept. |
| `POST /generate` | **Optional, development only.** A proxy that spends a key set in the server's own environment (`AI → Advanced → Shared AI service` in a dev build). It never accepts a key from a request (tested), only generates the extension's own schemas, and answers 503 when no server key is set — which is the production state. |

**User isolation** is structural rather than enforced: there is no shared state on the server that
could be reached with the wrong ID. User A's token lives in User A's browser and is sent only to
`api.notion.com`. A test (`tests/backend-api.test.js`) pins this: two exchanges yield two
independent tokens, the OAuth module exports no state, and no endpoint returns a token without a
fresh one-time code from that user's own sign-in window.

**Notion structure** is owned by the app, never by the model. The Brototype task decides the task
titles, subtopic titles, count and order; the AI supplies only explanations, examples, code and the
five reviewer questions. A task whose subtopics cannot all be generated after retries is failed
cleanly and offered for *Retry failed* — a structurally wrong page is never written.
See [ARCHITECTURE.md §6–§8](ARCHITECTURE.md).

## 2. Requirements

- Node.js **22** or newer (`node -v`)
- A Notion account, to create the **public** integration
- A [Render](https://render.com) account for the (Notion-OAuth-only) backend
- Each *user* needs their own AI key — OpenRouter has free models (§7)
- A Chrome Web Store developer account, to publish

## 3. Local setup

```bash
git clone <this repo>
cd study-ai

cd backend && npm install && cp .env.example .env     # fill in the values (§5, §6)
npm start                                              # http://localhost:8787

cd ../extension && npm install
npm run build                                          # development build -> extension/dist
```

Load `extension/dist` in Chrome: `chrome://extensions` → *Developer mode* → *Load unpacked*.
`npm run dev` rebuilds on every change; click ↻ on the extension card afterwards.

A development build talks to `http://localhost:8787` for Notion sign-in. Nothing in source has to
be edited to switch to production — see §10.

## 4. Backend

```
backend/
  src/index.js         Express app: CORS, rate limit, /health, OAuth exchange, /generate
  src/notion-oauth.js  code -> token with the client secret (server-side only)
  src/providers.js     (dev proxy only) which provider/model/key, from the environment
  src/schemas.js       (dev proxy only) the only output schemas /generate will produce
```

Run it with `npm start`; it prints what it can do:

```
Brototype AI Notes backend listening on 0.0.0.0:8787 (http://localhost:8787)
AI proxy off (normal for production: users bring their own provider keys)
Notion OAuth ready — redirect URI https://<id>.chromiumapp.org/notion
⚠️  ALLOWED_EXTENSION_IDS is not set — any extension may call this server (fine for development)
```

Production behaviour: binds `0.0.0.0` on `process.env.PORT`, trusts Render's proxy for client IPs,
rate-limits per IP, logs method/path/status only (never bodies, headers or tokens), answers every
error as JSON, and drains in-flight requests on `SIGTERM`.

## 5. Environment variables (backend)

| Variable | Required | Meaning |
|---|---|---|
| `NOTION_OAUTH_CLIENT_ID` | yes | From your public Notion integration. |
| `NOTION_OAUTH_CLIENT_SECRET` | yes | Same. **Server only.** |
| `NOTION_OAUTH_REDIRECT_URI` | yes | `https://<extension-id>.chromiumapp.org/notion` (§6). |
| `ALLOWED_EXTENSION_IDS` | production | Comma-separated extension id(s) allowed to call from a browser. Empty = any extension (development). |
| `NODE_ENV` | production | `production` hides developer `detail` fields from API error responses. |
| `PORT` | local only | Render sets its own. |
| `RATE_LIMIT_PER_MINUTE` | no | Requests per client IP per minute (default 30). |
| `OPENROUTER_API_KEY` etc., `DEFAULT_PROVIDER`, `*_MODEL`, `AI_TIMEOUT_MS` | **no — leave unset in production** | Only for the development-only `/generate` proxy. Setting one makes the server spend *your* key for dev builds that opt in; the published extension never calls it. |

Local: put them in `backend/.env` (gitignored). Render: dashboard → Environment, or accept the
prompts `render.yaml` generates. Never commit `.env`; the repo's `.gitignore` covers `.env`,
`.env.*`, `key.pem` and `.manifest-key`.

## 6. Notion OAuth setup (once, by whoever runs the backend)

1. <https://www.notion.so/my-integrations> → **New integration** → type **Public**.
   Notion requires a company name, website, **privacy policy URL** and **terms URL** for public
   integrations — host [PRIVACY.md](PRIVACY.md) somewhere (GitHub Pages works) and use that.
2. **Capabilities**: *Read content*, *Insert content*, *Update content*. (Read is needed to list
   pages and check for an existing weekly page; insert/update to write and to *Replace* a page.
   No user information beyond the workspace name is requested.)
3. **Redirect URI**: the extension's own URL, `https://<extension-id>.chromiumapp.org/notion`.
   The extension id is **pinned** by the `key` field in `extension/manifest.json` (the public
   half of `extension/key.pem`), so it is identical for every user, every build, and after
   publishing to the Web Store. Read it from the extension: **Notion → Advanced → Redirect URL**,
   or from `extension/.extension-id`. Notion matches it byte-for-byte.
4. Copy the **Client ID** and **Client Secret** into the backend environment (§5).

`extension/key.pem` is the private key. It is gitignored. Losing it does not break published users
(the store keeps the id), but back it up with your other secrets anyway.

## 7. AI setup (each user, in the extension)

**AI tab → Provider → API key → Save → Test connection.** Nothing on the server.

| Provider | Key from | Notes |
|---|---|---|
| **OpenRouter** (default) | <https://openrouter.ai/settings/keys> | One key, hundreds of models; `:free` models cost nothing but are rate-limited (~20 req/min shared). |
| Google Gemini | <https://aistudio.google.com/app/apikey> | Free tier, no card. |
| OpenAI | <https://platform.openai.com/api-keys> | Paid API account (ChatGPT subscriptions do not include it). |
| Anthropic Claude | <https://console.anthropic.com/settings/keys> | Paid API account. |
| xAI Grok | <https://console.x.ai> | Prepaid credits required. |
| Custom / OpenAI-compatible | you | DeepSeek, Groq, Together, LM Studio, local Ollama (`/v1`). |

The key is stored in that user's `chrome.storage.local`, shown masked after saving (Replace /
Delete), and sent only to the provider it belongs to. Each provider keeps its own saved key, so
switching never loses or mixes keys (`tests/user-owned-keys.test.js`). You, the publisher, pay for
nothing and see no keys.

## 8. Running locally, end to end

```bash
cd backend && npm start                       # terminal 1
cd extension && npm run dev                   # terminal 2
```

Load `extension/dist`, open a Brototype task page, click the 📚 icon:

1. **AI → OpenRouter → paste your key → Save → Test connection**.
2. **Notion → Continue with Notion** → approve → *Connected*.
3. **Create new page** (top level of your workspace) or **Choose existing page**.
4. **Generate** → tasks are detected from the page → *Generate study notes*.

The run happens in the service worker; closing the panel never loses it.

## 9. Tests

```bash
cd extension && npm test          # also runnable as `npm test` in backend/
```

396 tests, no browser and no network needed. Beyond the parsing, structure and provider tests
(`ARCHITECTURE.md §10`), the production-relevant ones are:

| File | What it proves |
|---|---|
| `user-owned-keys.test.js` | Fresh install = direct/OpenRouter/no key; all six providers accept their own key; a request carries only the **selected** provider's key, to that provider's host, in a header (never URL/body), never to the backend; switching providers switches keys without losing any; a rejected key names the right provider; no key in source. |
| `backend-api.test.js` | Real Express server on a port: PORT/0.0.0.0, `/health`, CORS allowlist (own extension yes, other extension/website 403, never `*`), a key in body/headers/query is **never used**, proxy is off (503) with no server key, unknown schemas refused, **two users' sign-ins independent and nothing kept**, no secret in any response. |
| `oauth-e2e.test.js` | The extension's OAuth module against the real backend over HTTP: connect → create destination page → ready. |
| `notion-oauth.test.js` | State parameter, cancellation, replay, refresh, error wording. |
| `release-build.test.js` | Builds a real release into a temp dir: refuses non-https backend, bundle contains only the deployed URL (no localhost, no `.env`, no source maps, no key patterns), manifest has minimum permissions. |
| `build.test.js` | The `dist/` build: manifest references, no `tabs`, no all-hosts access, CSP, no Notion token endpoint in the bundle. |
| `generation-integrity.test.js`, `structure.test.js`, `five-subtopics-pipeline.test.js`, `pipeline.test.js` | Every source subtopic appears exactly once, in order, nothing invented/merged/renamed; exactly 5 reviewer questions; an unwritable task fails cleanly; successful tasks are not regenerated on retry. |
| `openrouter-response.test.js`, `adapters.test.js` | Empty, malformed, truncated, rate-limited and 5xx provider replies; retry vs. permanent failure. |
| `ui.test.js`, `generate-ui.test.js`, `notion-destination-ui.test.js` | Every state of every screen, rendered and clicked: disconnected Notion, no destination, shared AI, loading, errors, retry. |

## 10. Building the extension

```bash
cd extension
npm run build                                        # development: backend = http://localhost:8787
BACKEND_URL=https://<service>.onrender.com npm run build:release   # release
```

Or put `BACKEND_URL=https://…` in `extension/.env` (gitignored) and run `npm run build:release`.
A release build **refuses** a missing or non-https URL, bakes the URL into the code, adds the
matching `host_permissions` entry, emits no source maps, and contains no development literal —
`tests/release-build.test.js` checks all of this on every test run.

Zip the contents of `extension/dist` (not the folder) for the Web Store.

## 11. Render deployment

`render.yaml` at the repo root is a Render Blueprint.

1. Push the repo to GitHub (check `git status` shows no `.env`, `key.pem`).
2. Render → **New → Blueprint** → select the repo. Render creates the service from `render.yaml`
   and asks for each `sync: false` value:
   `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `NOTION_OAUTH_REDIRECT_URI`,
   `ALLOWED_EXTENSION_IDS`. **Do not set any `*_API_KEY`.**
3. Deploy. Check `https://<service>.onrender.com/health` returns
   `{"ok":true,"aiConfigured":false,"notionOAuth":true,...}` (`aiConfigured:false` is expected).
4. Build the extension against that URL (§10).

Details: build `cd backend && npm ci --omit=dev`, start `cd backend && npm start`, health check
`/health`, Node 22, root dir `.` because the backend imports `../extension/src/ai`.
The free plan sleeps after 15 min idle; the first request then takes ~30 s, which the extension
reports as *AI service is temporarily unavailable — try again*. A paid instance avoids that.

## 12. Chrome Web Store

1. Build a release (§10) and zip `extension/dist/*`.
2. Developer Dashboard → New item → upload. The store keeps the id from `manifest.json`'s `key`,
   so the Notion redirect URI does not change.
3. Listing: name, description (≤132 chars — the manifest's is), icons (in `public/icons`),
   screenshots, category *Productivity*.
4. **Privacy tab** — required because the extension uses `identity` and sends data to a remote
   service. Answer from [PRIVACY.md](PRIVACY.md); host it and paste the URL. Declare:
   *website content* (the task list, only on brototype.com) and *authentication information*
   (Notion OAuth token and the user's own AI provider key, both stored locally). Not sold, not
   used for unrelated purposes.
5. Permission justifications (the reviewer asks): `storage` settings + token; `identity` Notion
   sign-in window; `scripting` + `activeTab` + `brototype.com` read the task list on demand;
   `sidePanel` the UI; `api.notion.com` write notes; `generativelanguage.googleapis.com` Gemini
   with the user's own key (the other providers allow browser CORS and need no host entry); your
   Render origin the Notion sign-in backend.
6. Remote code: none. All JS is in the package; the extension only calls APIs. CSP is
   `script-src 'self'; object-src 'self'`.

## 13. Production configuration checklist

| | Development | Production |
|---|---|---|
| Backend | `npm start` locally, `.env` | Render, dashboard env vars, `NODE_ENV=production` |
| `ALLOWED_EXTENSION_IDS` | empty | the published extension id |
| Extension build | `npm run build` | `npm run build:release` with `BACKEND_URL=https://…` |
| Backend URL in extension | localhost, overridable under *Advanced* | baked in; overrides ignored unless https |
| Source maps | yes | no |
| Error `detail` from backend | included | hidden (logged server-side) |

Users never edit anything: the published build already knows the backend.

## 14. Security notes

- **The only server-side secret is the Notion client secret.** There is no AI key anywhere in the
  system except each user's own, in their own browser. The extension package contains no key of
  any kind; `release-build.test.js`, `build.test.js` and `user-owned-keys.test.js` fail the suite
  if one appears.
- **A user's AI key** is in `chrome.storage.local` — readable only by this extension in that
  Chrome profile (and by anyone with full access to that machine, as with any stored credential).
  It is sent only to the provider it belongs to, never to the backend (tested at both ends), never
  in a URL, never logged, never in an error message.
- **Notion tokens** are per user, in that user's `chrome.storage.local`, sent only to
  `api.notion.com`. Never logged (the job log records counts and titles only). *Disconnect*
  forgets them; revoke from Notion → Settings → Connections.
- **The backend is a public URL with only the Notion client secret behind it**, which it uses
  solely to swap one-time codes for tokens. There is no AI key to abuse. If you ever set one for
  the dev proxy on a public deployment, the mitigations are: known schemas only, provider/model/
  endpoint fixed server-side, no key accepted from requests, per-IP rate limit, CORS allowlist —
  but a spoofed-Origin script could still spend it, so don't.
- **CORS** never uses `*` with credentials — there are no credentials. Origins are echoed only
  for `chrome-extension://` and, in production, only for the allow-listed id.
- **The `key` in `manifest.json` is the public key.** Safe to ship; it is what pins the id.
  `key.pem` is private and gitignored.
- The content script has no import path to any key or token (`tests/build.test.js`), runs only
  when the panel asks it to, and only on the tab you are looking at.

## 15. Troubleshooting

| What you see | Cause / fix |
|---|---|
| *Notion connection service is unavailable* | Backend down or asleep (Render free tier). Try again in 30 s. Dev: `cd backend && npm start`. |
| *Notion sign-in is not available yet* | Backend has no `NOTION_OAUTH_*` values. Its log names the missing ones. |
| *Notion sign-in is not set up correctly for this installation* | Redirect URI mismatch. Compare **Notion → Advanced → Redirect URL** with the integration's list and `NOTION_OAUTH_REDIRECT_URI`. |
| *Your Notion connection has expired. Reconnect Notion to continue.* | Token revoked/expired. Notion tab → Continue with Notion. |
| *Notion doesn't have permission to read and add content here* | Integration capabilities (§6) or the page wasn't ticked during sign-in. Reconnect and tick it. |
| *OpenRouter rejected your API key* / *Gemini rejected…* | That user's own key is wrong or revoked. AI tab → Replace. |
| *… says your account is out of quota or credit* | The user's provider account needs billing/credits, or a free model is exhausted. Switch model or provider on the AI tab. |
| *The AI service is temporarily unavailable* | Provider outage or (dev builds only) the backend proxy is off. Retry. |
| *Couldn't generate notes for this task. You can retry it.* | The model could not produce every subtopic after retries; nothing was written for that task. **Retry failed** redoes only failed tasks. |
| *Too many requests* | Per-IP limit (30/min). A whole classroom behind one NAT shares an IP — raise `RATE_LIMIT_PER_MINUTE`. |
| Free `:free` OpenRouter model 429s constantly | Free models are rate-limited per key. The extension paces and retries; pick a paid model on the AI tab if it persists. |
| *Open a Brototype task page to get started* | The panel only sees `*.brototype.com` tabs. Switch to the task tab; or use **Paste tasks**. |
| Extension id changed after loading unpacked | `manifest.json` lost its `key` field. Restore it; the Notion redirect depends on it. |
| `CORS` errors in the service-worker console | `ALLOWED_EXTENSION_IDS` on the server does not include this build's id (unpacked builds keep the same id thanks to `key`; check `chrome://extensions`). |
# brototype-ai-notes-extension
