# 📚 Brototype AI Notes

A Chrome extension that reads your Brototype task page, writes complete beginner study notes with
AI, and builds an organised page in **your own Notion** — with 5 reviewer questions per task.

```
Brototype task page
      ↓  extension reads the numbered task list (only when you open the panel on that page)
Chrome extension
      ↓  sends task titles + subtopic titles
Shared backend (Render)  ──→  AI provider (OpenRouter)      ← the only place an AI key exists
      ↓  structured notes come back
Chrome extension
      ↓  writes pages with YOUR Notion token (stored only in your Chrome profile)
Your Notion workspace
```

One published extension, one shared backend, and every user's **own** Notion account and notes.
The backend keeps no user data: no accounts, no sessions, no tokens, no database.

- **[PRIVACY.md](PRIVACY.md)** — exactly what data goes where. Host it and link it from the Web Store listing.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — why it is built this way and what the AI is and is not allowed to decide.
- This file — setup, deployment and operations.

---

## 1. Architecture

| Part | Where it runs | What it holds |
|---|---|---|
| `extension/` | Each user's Chrome | That user's Notion OAuth token, chosen destination page, settings, the current run. All in `chrome.storage.local` (per profile, unreadable by websites). |
| `backend/` | One Render web service | `OPENROUTER_API_KEY`, `NOTION_OAUTH_CLIENT_SECRET`. **Nothing per user.** |
| Notion | notion.so | The generated pages, in the user's workspace, created by the user's own connection. |

The backend has three real endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{ ok: true, aiConfigured, notionOAuth, providers }` — Render's health check and the extension's *Test connection*. |
| `GET /notion/oauth/config` + `POST /notion/oauth/exchange` | Notion is a *confidential-client* OAuth flow (HTTP Basic `client_id:client_secret`, no PKCE), so the code→token swap must happen where the secret is. The token goes straight back to that user's extension and is not kept. |
| `POST /generate` | Prompt + one of the extension's known output schemas in, structured notes out. The server chooses provider, model and endpoint from its environment; a request cannot change them. |

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
- An [OpenRouter](https://openrouter.ai) key (or any other supported provider — see §5)
- A [Render](https://render.com) account for the backend
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

A development build talks to `http://localhost:8787` for both Notion sign-in and AI. Nothing in
source has to be edited to switch to production — see §10.

## 4. Backend

```
backend/
  src/index.js         Express app: CORS, rate limit, /health, OAuth exchange, /generate
  src/notion-oauth.js  code -> token with the client secret (server-side only)
  src/providers.js     which AI provider/model/key, from the environment
  src/schemas.js       the only output schemas /generate will produce
```

It imports the extension's own provider adapters (`extension/src/ai/*`), so there is exactly one
implementation of each provider. Run it with `npm start`; it prints what it can do:

```
Brototype AI Notes backend listening on 0.0.0.0:8787 (http://localhost:8787)
AI providers with keys: openrouter — default: openrouter
Notion OAuth ready — redirect URI https://<id>.chromiumapp.org/notion
⚠️  ALLOWED_EXTENSION_IDS is not set — any extension may call this server (fine for development)
```

Production behaviour: binds `0.0.0.0` on `process.env.PORT`, trusts Render's proxy for client IPs,
rate-limits per IP, logs method/path/status only (never bodies, headers or tokens), answers every
error as JSON, and drains in-flight requests on `SIGTERM`.

## 5. Environment variables (backend)

| Variable | Required | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | yes (one provider key) | The shared AI key. Never leaves the server. |
| `OPENROUTER_MODEL` | no | Model to spend it on. Default: the extension registry default (a `:free` model — fine for testing, **not** for many simultaneous users, see §15). |
| `DEFAULT_PROVIDER` | no | Which provider serves requests (`openrouter`). Default: the first with a key. |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_API_KEY`, `GROK_API_KEY`, `CUSTOM_API_KEY` (+ `*_MODEL`, `*_BASE_URL`) | no | Alternative providers, same pattern. |
| `NOTION_OAUTH_CLIENT_ID` | yes | From your public Notion integration. |
| `NOTION_OAUTH_CLIENT_SECRET` | yes | Same. **Server only.** |
| `NOTION_OAUTH_REDIRECT_URI` | yes | `https://<extension-id>.chromiumapp.org/notion` (§6). |
| `ALLOWED_EXTENSION_IDS` | production | Comma-separated extension id(s) allowed to call from a browser. Empty = any extension (development). |
| `NODE_ENV` | production | `production` hides developer `detail` fields from API error responses. |
| `PORT` | local only | Render sets its own. |
| `RATE_LIMIT_PER_MINUTE`, `AI_TIMEOUT_MS` | no | Tuning (defaults 30, 180000). |

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

## 7. OpenRouter setup

1. <https://openrouter.ai/settings/keys> → create a key → `OPENROUTER_API_KEY` on the backend.
2. Optional: `OPENROUTER_MODEL=<model id from openrouter.ai/models>`. The registry default is a
   free, rate-limited model; for a class of students set a paid model and a spending limit on the
   key.
3. The extension never sees this key. Students do not configure anything for AI.

Anyone who prefers their own account can still use it: **AI → Advanced → My own API key** stores a
key in that person's Chrome profile and calls the provider directly (the pre-existing "direct" mode).

## 8. Running locally, end to end

```bash
cd backend && npm start                       # terminal 1
cd extension && npm run dev                   # terminal 2
```

Load `extension/dist`, open a Brototype task page, click the 📚 icon:

1. **Notion → Continue with Notion** → approve → *Connected*.
2. **Create new page** (top level of your workspace) or **Choose existing page**.
3. **Generate** → tasks are detected from the page → *Generate study notes*.

The run happens in the service worker; closing the panel never loses it.

## 9. Tests

```bash
cd extension && npm test          # also runnable as `npm test` in backend/
```

386 tests, no browser and no network needed. Beyond the parsing, structure and provider tests
(`ARCHITECTURE.md §10`), the production-relevant ones are:

| File | What it proves |
|---|---|
| `backend-api.test.js` | Real Express server on a port: PORT/0.0.0.0, `/health`, CORS allowlist (own extension yes, other extension/website 403, never `*`), body `baseUrl`/`model` ignored, unknown schemas refused, operator errors translated, retryable classification, **two users' sign-ins independent and nothing kept**, no secret in any response. |
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
   `OPENROUTER_API_KEY`, `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`,
   `NOTION_OAUTH_REDIRECT_URI`, `ALLOWED_EXTENSION_IDS`.
3. Deploy. Check `https://<service>.onrender.com/health` returns
   `{"ok":true,"aiConfigured":true,"notionOAuth":true,...}`.
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
   (Notion OAuth token, stored locally). Not sold, not used for unrelated purposes.
5. Permission justifications (the reviewer asks): `storage` settings + token; `identity` Notion
   sign-in window; `scripting` + `activeTab` + `brototype.com` read the task list on demand;
   `sidePanel` the UI; `api.notion.com` write notes; `generativelanguage.googleapis.com` the
   optional own-key Gemini path; your Render origin the backend.
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

- **Secrets exist only on the backend.** The extension package contains no AI key and no Notion
  client secret; `release-build.test.js` and `build.test.js` fail the suite if one appears.
- **Notion tokens** are per user, in that user's `chrome.storage.local`, sent only to
  `api.notion.com`. Never logged (the job log records counts and titles only). *Disconnect*
  forgets them; revoke from Notion → Settings → Connections.
- **The backend is a public URL with a key behind it.** Mitigations: only the extension's own
  schemas are generated, provider/model/endpoint are fixed server-side, per-IP rate limit, CORS
  restricted to the extension id. What it cannot prevent: someone extracting the URL and calling
  `/generate` with a spoofed Origin from a script. Set a **spending limit** on the OpenRouter key
  and watch Render's logs (`POST /generate 200 12034ms` lines) for abuse. A per-user login would
  be the next step if that ever matters.
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
| *The AI service is temporarily unavailable* | Backend unreachable, no key, key rejected, out of credit, or provider down. Backend log has `[generate] AI_BAD_KEY: …` etc. Users just retry. |
| *Couldn't generate notes for this task. You can retry it.* | The model could not produce every subtopic after retries; nothing was written for that task. **Retry failed** redoes only failed tasks. |
| *Too many requests* | Per-IP limit (30/min). A whole classroom behind one NAT shares an IP — raise `RATE_LIMIT_PER_MINUTE`. |
| Free `:free` OpenRouter model 429s constantly | Free models share ~20 req/min *across all users*. Set `OPENROUTER_MODEL` to a paid model. |
| *Open a Brototype task page to get started* | The panel only sees `*.brototype.com` tabs. Switch to the task tab; or use **Paste tasks**. |
| Extension id changed after loading unpacked | `manifest.json` lost its `key` field. Restore it; the Notion redirect depends on it. |
| `CORS` errors in the service-worker console | `ALLOWED_EXTENSION_IDS` on the server does not include this build's id (unpacked builds keep the same id thanks to `key`; check `chrome://extensions`). |
# brototype-ai-notes-extension
