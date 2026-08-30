# Brototype AI Notes — Architecture

## 0. The one-line goal
Open Brototype → extension detects this week's tasks → AI writes complete beginner study notes
→ Notion receives a clean, expandable page with 5 reviewer questions per task.

> **Status: built, tested, and prepared for public distribution.** 386 automated tests, including
> a fixture captured from the real Brototype task page (`fixtures/brototype-task-page.html`). See
> §10 for what the real page taught us, and §6 for the provider-independent AI layer.
>
> **Public-release update (Aug 2026).** The published extension follows §1–§2 almost exactly:
> every user brings their **own AI key** (OpenRouter by default, any registry provider), stored
> in their own `chrome.storage.local` and sent directly to that provider — the "direct" mode
> described in §6. The one shared backend on Render does only what §2 says genuinely needs a
> server: the Notion OAuth token exchange. It holds the Notion client secret, no AI key, and no
> user state. (`/generate` remains as a development-only proxy, off unless an operator sets a key.)
> Threat model and deployment steps: [README.md](README.md) §1, §7, §14.

---

## 1. What can be done ENTIRELY inside the Chrome extension?

| Job | Inside extension? | Why |
|---|---|---|
| Read the Brototype DOM | ✅ Yes | Content script has direct DOM access. Impossible from a backend (page is behind your login). |
| Parse tasks / subtopics | ✅ Yes | Pure JS on the extracted DOM. |
| Call Notion API | ✅ Yes | MV3 service worker + `host_permissions: api.notion.com` **bypasses CORS**. Notion's API is not callable from a normal web page, but it *is* callable from an extension SW. |
| Call any AI provider API | ✅ Yes | Same CORS bypass, for Gemini, OpenAI, Claude, Grok or any OpenAI-compatible server. The question is only *where the key lives* (§6). |
| Long generation while popup is closed | ✅ Yes | Generation runs in the **service worker**, not the popup. Popup is a thin viewer of persisted job state. |
| Store tokens | ✅ Yes | `chrome.storage.local` (per-profile, not synced, not readable by web pages). |
| Notion **OAuth** | ⚠️ Partly | `chrome.identity.launchWebAuthFlow` handles the redirect, but the token exchange needs a **client secret** → requires a backend. |

**Conclusion: 95% of this product is achievable with zero backend.**

## 2. What genuinely requires a backend?

Only two things, and both are optional for personal use:

1. **Notion public OAuth** — the `client_secret` must never ship in an extension.
2. **A shared AI key** — if you ever give this extension to other Brototype students, they must not
   see your key. A proxy is the only correct answer then.

For *you alone, running an unpacked extension on your own machine*, neither is required:
- Notion **internal integration token** = the official Notion API path for personal use. No secret, no backend.
- **Your own** AI key in `chrome.storage.local` = the key never leaves your machine and is never in git.

So the plan is: **ship extension-only by default, with a small Node backend as a drop-in swap** once you
want OAuth or want to share the extension. The extension talks to an interface, never to a specific vendor.

---

## 3. How Brototype task detection works

Four layers, each falling back to the next:

```
Layer 1  Saved selector      → you picked the task container once; reuse it
Layer 2  Structural scan     → find every element whose OWN text starts with "N."
Layer 3  Visual picker       → "Click the task list" → saves a selector → Layer 1 next week
Layer 4  Manual paste        → paste the task text; the same parser handles it
```

**Layer 2 in detail.** Brototype's frontend is styled-components, so class names look like
`sc-gSILEF fXTRBO` — and those hashes are regenerated on *every* Brototype build. Selecting on
them would break within weeks. So the scan is structural:

1. Look at every `h1..h6, p, div, span, li, strong, b, a, td` on the page.
2. Keep the ones whose **own** text (direct text nodes only, so parents don't match) parses as
   `N. Title`.
3. Group matches by `tagName + DOM depth`, keep the largest group. That discards a stray "1." in
   a paragraph of prose.
4. For each heading, the subtopics are the next sibling that has text and contains **no form
   controls** — that last rule is what excludes Brototype's "Text Response / Submit Answer /
   Attach Files / Record Audio" widget sitting in the same card.

**Layer 2's hardest problem — `i.` is ambiguous.** On the real page, task 12 nests roman numerals
under letters, while task 13 runs `a.` through `j.`:

```
12.  a. Use AI For          13.  h. Create reusable custom hooks
      i. Architecture …           i. Build production-ready frontend architecture   ← 9th LETTER
```

`parse.js` resolves it by tracking the letter run: `i.` is a letter only when it is the letter the
current `a, b, c…` run is up to, at the same indent. Otherwise it is roman numeral one and nests.
Indentation is used when present; the letter-run rule is the fallback so nesting survives even if
Brototype strips the whitespace.

Output is a **normalised structure** the rest of the app depends on — nothing downstream ever
touches the DOM again:

```json
{ "ok": true,
  "unit": { "title": "React - Advanced Concepts", "sem": "Sem 1", "paper": "Paper 2",
            "module": "Mod 6", "status": "Assigned" },
  "pageTitle": "Mod 6 — React - Advanced Concepts",
  "tasks": [ { "number": 1, "title": "Understand Advanced React Hooks",
               "subtopics": [ { "title": "useContext", "children": [] } ] } ],
  "warnings": [] }
```

**Injection.** There is deliberately no `content_scripts` block in the manifest. The content script
is injected on demand with `activeTab` + `chrome.scripting` when you click the extension icon. That
means the extension needs no advance permission for Brototype's domain, only ever reads the tab you
explicitly opened it on, and keeps working if Brototype ever changes its URL.

## 4. What breaks if Brototype changes its HTML?

Only `content/extractor.js`. Everything else consumes the normalised JSON above.
- Saved selector stops matching → auto-falls back to heuristics → then to the picker.
- The UI **shows you what it detected before generating**, and lets you edit/add/remove tasks.
  → "Only some tasks detected" is a visible, fixable state, never a silent failure.

## 5. How Notion integration should work

**Public OAuth — what the "Continue with Notion" button does.**
1. Worker reads `clientId` + `redirectUri` from the backend's `GET /notion/oauth/config`.
2. It mints a 256-bit `state` into `chrome.storage.session` and opens
   `https://api.notion.com/v1/oauth/authorize?client_id&response_type=code&owner=user&redirect_uri&state`
   with `chrome.identity.launchWebAuthFlow`.
3. Notion redirects to `https://<extension-id>.chromiumapp.org/notion?code&state`, which Chrome
   intercepts and hands back — no localhost listener, no stray tab.
4. `state` is compared and consumed; a mismatch throws the code away rather than spending it.
5. `POST <backend>/notion/oauth/exchange { code, redirectUri }` → the backend does the Basic-auth
   call to `POST /v1/oauth/token` → the extension stores only `notionAuth.accessToken`.
6. The destination is chosen once, without leaving the extension:
   - **Create New Page** → `POST /v1/pages` with `parent: { type: 'workspace', workspace: true }`,
     which Notion permits only for a public (OAuth) connection — an internal integration has no user
     to own a top-level private page, so that button is not shown for one.
   - **Select Existing Page** → `POST /v1/search` over the pages ticked during authorisation.

   Either way the resulting id lands in `notionParentId`, and everything below this point is
   unchanged: weekly study pages are still created as children of it by `createStudyPage`.

**Why the backend is not optional for this.** Notion's token endpoint authenticates with HTTP Basic
`client_id:client_secret` and offers no PKCE for integration authorisation, so the exchange cannot
be completed by a public client. `backend/src/notion-oauth.js` holds the secret; nothing else does.

**Which server.** Baked in at build time by `NOTION_BACKEND_URL` (`lib/env.js`, `vite.config.js`),
defaulting to `http://localhost:8787` for development. `build.js` adds the matching
`host_permissions` entry, so the code and the manifest cannot disagree — a build test asserts they
do not. `config.notionOAuthBackendUrl` is an optional runtime override; empty means "this build's
own server", so a stored dev URL can never pin a release build to a localhost that is not running.

**When the server is down** the user sees *Notion connection service is unavailable* and a **Try
again**; which URL failed and why is carried in `AppError.detail`, which the UI renders only on a
development build. The Notion tab makes no network call to describe itself — an earlier version
probed the backend on render, which is how a stopped dev server became the first thing a user saw.

**Alternative: Internal Integration (pre-OAuth, still supported).** Paste an `ntn_...` secret under
**Notion → Advanced**. `resolveNotionToken()` prefers OAuth when both exist, so an existing setup
keeps working and is never overwritten. Both paths produce a bearer token; every call below `notion/`
takes that token as an argument and knows nothing about where it came from.

**Duplicate strategy** — before creating the page, list the parent's child pages:
| Case | Behaviour |
|---|---|
| Title not present | Create it. |
| Title exists, strategy `ask` | Popup offers: **Create `… (v2)`** (default, never destroys) / **Replace contents** / **Append to existing** |
| Title exists, strategy `new`/`update`/`skip` | Do that without asking. |
| Run died halfway | The job stores its own task list; **Resume** re-runs only the tasks not marked `done`, into the same page. |

**Notion API limits that shape the code** (real constraints, not theory):
- 100 blocks per `PATCH /blocks/{id}/children` request → chunked appends.
- 2000 characters per rich-text object → long text is split across paragraph blocks.
- Only 2 levels of nesting per request → we create `Week` page, then per-task toggle, then append
  each subtopic toggle with its content as children. This also gives natural per-task progress.
- ~3 requests/second → a request queue with throttle + 429 `Retry-After` backoff.

## 6. The AI layer: provider-independent by construction

Two **independent** axes. Conflating them is the mistake that makes an extension
Gemini-shaped, so they are kept apart:

```
mode            direct | backend            HOW the provider is reached
activeProvider  gemini | openai | claude | grok | custom     WHICH provider it is
```

Every combination works, including "Grok via backend" and "Gemini direct".

```
        generator.js         pacing, retries, split-on-truncation, validation
             │               contains NO vendor names (asserted by a test)
             │  provider.generateStructured(prompt, schema, signal)
             ▼
        provider.js          resolves the two axes into one small facade
             │
    ┌────────┴─────────────────────────────┐
    ▼ direct                               ▼ backend
  registry.js → adapter                 transport.js → your Node server
    ├── gemini.js               responseSchema        │  which imports the SAME
    ├── openai-compatible.js    response_format       │  adapter files (§8), so
    │     serves openai, grok, custom, Ollama…        │  there is exactly ONE
    └── claude.js               forced tool call      │  implementation of each
                                                       provider, never two
```

**Adding a provider is one registry entry.** `registry.js` holds the label, default base URL,
default model, model suggestions, key hint, and — the important bit — its capabilities. Nothing
else in the project changes.

**Why one `openai-compatible.js` instead of `openai.js` + `grok.js`.** They send byte-identical
requests to `POST /chat/completions`. Two files would be copies that drift, and every new
compatible service would need a third. One parameterised adapter means DeepSeek, Groq, OpenRouter,
Together, LM Studio and Ollama all work through the `custom` entry with no code at all. If a vendor
genuinely diverges, it gets its own adapter and one line changes in the registry.

### Structured output: the same result, four different mechanisms

Providers force valid JSON in genuinely different ways. Pretending they are identical is how you
end up parsing chat prose, so each declares what it actually supports:

| Provider | Mechanism | How |
|---|---|---|
| Gemini | `response_schema` | `generationConfig.responseSchema`, constrained during decoding |
| OpenAI, Grok | `json_schema` | `response_format: {type:'json_schema', strict:true}` |
| Claude | `tool` | a **forced tool call** whose `input_schema` is our schema — Claude has no `response_format`, and this is just as strict |
| Custom | `auto` | probe `json_schema` → `json_object` → schema-in-the-prompt, and remember what worked |

The canonical schema is written **once**, in neutral JSON Schema, and translated per dialect:

- `toGeminiSchema()` — uppercases types and adds `propertyOrdering` (Gemini's OpenAPI flavour)
- `toStrictJsonSchema()` — adds `additionalProperties:false`, requires every key, and **strips
  `minItems`/`maxItems`**, which OpenAI strict mode rejects
- Claude and the prompt fallback take the neutral schema as-is

A test asserts the converters never mutate the shared schema, and that the strict dialect really is
strict-legal at every depth.

**Crucially, the mechanism only changes how likely a bad response is — never what reaches Notion.**
Every response, from every provider, passes through `normaliseTask()` before a single Notion block
is built. A weaker provider means more retries, not worse data.

### Study style: user-owned presentation, app-owned structure

The system message is assembled from three parts, in this order:

```
CORE_RULES      app-owned    structure, "every field or empty", "exactly these subtopics"
<study_style>   user-owned   default text, or the student's custom instructions (≤ 4000 chars)
PRECEDENCE      app-owned    restates, AFTER the style, that structure wins on any conflict
```

The user message carries task data only; the style has no channel into it, so it cannot change
which subtopics are covered. Stored as `config.studyStyle = { mode, customPrompt }`, deliberately
apart from `config.ai` (preference vs credentials). An empty custom prompt resolves to the default.

What actually guarantees the schema is not the wording above but two mechanical layers: every
provider receives the schema *outside* the prompt (Gemini `responseSchema`, OpenAI `json_schema`,
Claude tool `input_schema`) and enforces it during decoding; then `normaliseTask()` validates every
response before Notion. Tests send four adversarial custom prompts ("ignore the schema", "drop
reviewQuestions", "rename useReducer", an early `</study_style>`) and assert the outgoing schema is
byte-identical and the task data unchanged.

No adapter changed for this feature. That is the provider boundary doing its job.

### The application owns the Notion structure; the model only supplies text

```
AI (any provider / any OpenRouter model)
  ↓  JSON in whatever shape the model managed
normaliseTask()       schema.js   accepts aliases ("problem", "sections.simpleExample",
                                  "subtopics", "questions", topics keyed by title, wrappers)
cleanProse/List/Code  content.js  strips markdown headings, "**Label:**" prefixes, bullet
                                  markers, code fences - the structure a model smuggles INTO
                                  a field - so two models cannot yield two layouts
SECTION_KINDS         schema.js   the AI returns sections: [{ heading, kind, content }],
                                  kind ∈ text | list | code | table, at most 8 per subtopic,
                                  ONLY the sections the topic needs (no fixed template)
buildMainTopicBlock   blocks.js   ▸ 1. Main topic      toggle H1
  buildSubtopicToggle             ▸ a. Subtopic        toggle H2
    buildSectionHeading             <AI's heading>       H3
    buildSectionContent             paragraph | bullets | numbered | code | table
  ↓
Notion API            pages.js    written in layers (2 nesting levels per request)
```

The model chooses which sections a topic needs, their headings and their words - nothing else.
It never chooses a block type, heading level, letter, or parent; unknown kinds fall back to what
the content implies, empty sections vanish, and the count is capped in code. `tests/structure.test.js` feeds one set of
notes in five model dialects (clean Gemini, GPT with markdown inside fields, Llama with a wrapper
and invented keys, DeepSeek with topics keyed by title and fenced code, Claude with numbered
questions) and asserts a byte-identical structure signature from all five.

### Where the key goes

- Bundling a key in the extension source = ❌ unsafe (anyone can unzip a published extension).
- Your key in `chrome.storage.local`, entered by you, on your machine = ✅ fine for personal use.
  Same trust model as a `.env` on your laptop. Not in git, not in the bundle. This is *acceptable
  for personal use*, not a secure vault.
- A key shared with other users = ❌ must go behind the Node backend, which holds it in `.env`.
- **The content script never receives any key.** It has no import path to the AI layer, the Notion
  client or the config store — asserted by a test that walks its import graph, plus a scan of the
  built bundle. All network calls happen in the service worker.
- Keys are stored per provider, so switching Gemini → Grok → back never destroys either.
- The Options page never renders a saved key: it shows `••••••••abcd` with Replace and Delete.

### Reliability

One call **per main task** (not per week — 13 tasks in one response would blow any output budget).
If a response is truncated (`MAX_TOKENS` / `finish_reason: length` / `stop_reason: max_tokens`,
normalised to `AI_TRUNCATED` by each adapter), the generator automatically splits that task into
per-subtopic calls and merges. Requests are paced at the active provider's own rate.

## 7. Known limitations (honest list)
- Brototype HTML changes → extractor needs a re-pick (30 seconds, built into the UI).
- Free tiers have per-minute and daily limits; 13 tasks ≈ 13–30 calls, so a full module fits, but
  two full runs in a minute may hit 429 → paced and retried with backoff, and progress is resumable.
- Provider *quality* differs, and no adapter can fix that. A weak model produces valid JSON with
  shallow content; validation catches malformed output, not mediocre writing.
- Notion API cannot create *databases inside* a page you didn't share with the integration.
- AI content is AI content: good study scaffolding, not a guaranteed-correct textbook.
- Service worker can be killed by Chrome; job state lives in `chrome.storage.local` so a killed
  worker resumes instead of losing work.

## 8. Project layout (as built)

```
study ai/
├── ARCHITECTURE.md              this file
├── README.md                    setup, commands, testing
├── fixtures/
│   └── brototype-task-page.html captured from the real page; the tests run against it
├── extension/
│   ├── manifest.json            MV3. No content_scripts - injection is on demand.
│   ├── build.js                 runs both Vite builds + copies manifest/icons
│   ├── vite.config.js           popup + options + service worker (ES modules)
│   ├── vite.content.config.js   content script (one IIFE file - content scripts
│   │                            cannot be ES modules)
│   ├── popup.html, options.html
│   ├── tools/make-icons.mjs     generates the PNG icons, no image library
│   ├── tests/                   29 tests, plain `node --test`
│   └── src/
│       ├── content/parse.js     TEXT -> nested subtopics. Pure, heavily tested.
│       ├── content/extractor.js DOM -> normalised structure. BROTOTYPE-AWARE.
│       ├── content/picker.js    click-to-select fallback
│       ├── content/index.js     content-script entry (message handler)
│       ├── background/worker.js the service worker: runs the whole job
│       ├── background/job.js    job shape + persistence to chrome.storage
│       ├── ai/registry.js      ADD A PROVIDER HERE. Defaults + capabilities.
│       ├── ai/provider.js       resolves mode + provider into one facade
│       ├── ai/gemini.js         adapter: responseSchema
│       ├── ai/openai-compatible.js  adapter: openai, grok, custom, Ollama…
│       ├── ai/claude.js         adapter: forced tool call
│       ├── ai/transport.js      backend mode (a transport, not a provider)
│       ├── ai/http.js           shared fetch + error translation
│       ├── ai/json.js           tolerant JSON reading for weak providers
│       ├── ai/schema.js         neutral schema + dialect converters + validator
│       ├── ai/prompt.js         all prompt wording lives here
│       ├── ai/generator.js      pacing, retries, split-on-truncation
│       ├── notion/client.js     throttled REST client + error translation
│       ├── notion/oauth.js      launchWebAuthFlow + state check + refresh-on-401
│       ├── notion/blocks.js     notes -> Notion blocks. Pure, tested.
│       ├── notion/pages.js      create/find/fill pages, duplicate strategy
│       ├── lib/env.js           which sign-in server this build targets
│       ├── lib/storage.js       chrome.storage.local config
│       ├── lib/errors.js        AppError: every failure has a human message
│       ├── ui/                  shared React bits + styles + messaging
│       ├── popup/               React popup
│       └── options/             React settings page + AiProviderSection.jsx
└── backend/                     Optional for AI. REQUIRED for Notion OAuth.
    ├── src/providers.js         imports extension/src/ai/* — zero duplication
    ├── src/notion-oauth.js      the only place the Notion client secret exists
    └── src/index.js             POST /generate, GET /health, /notion/oauth/*
```

The backend deliberately imports the extension's adapter files directly. They use no browser APIs,
so Node can run them unchanged — which is what guarantees "Grok via backend" and "Grok direct"
cannot drift apart. Its `.env` may hold a key per provider (`GEMINI_API_KEY`, `GROK_API_KEY`, …)
and `/health?providerId=grok` reports whether it can serve that one.

## 9. Build order (all done)
1. ✅ Extension skeleton + manifest + two-pass build → loads in Chrome.
2. ✅ Parser + extractor + picker + manual paste → **verified: 13/13 tasks off the real page.**
3. ✅ Options page: Notion token + page picker, Gemini key + model, with Test buttons.
4. ✅ AI provider + schema + generator (pacing, retries, split-on-truncation).
5. ✅ Notion block builder + page creator → verified against every documented Notion limit.
6. ✅ Job runner in the service worker + progress UI + resume.
7. ✅ Optional Node backend.
9. ✅ **Study style** — default/custom, sandwiched between app-owned rules, mechanically unable to
   touch the schema or the task list. Replaces the old Depth dropdown.
8. ✅ **Provider-independent AI layer** — 5 providers, 2 modes, per-provider stored config,
   dialect converters, capability-driven fallback, and an Options UI driven entirely by the registry.
   +43 tests, including one asserting the content script cannot reach any key.

## 10. What the real Brototype page changed

Seeing the actual HTML corrected three assumptions:

1. **There is no "Week".** The page identifies itself as `React - Advanced Concepts` with chips
   `Sem 1`, `Paper 2`, `Mod 6`. So pages are named `Mod 6 — React - Advanced Concepts`, and the
   title is editable in the popup before you generate. The `Week N` regex is kept as a fallback in
   case other Brototype courses use it.
2. **Class names are disposable.** styled-components hashes (`sc-gSILEF fXTRBO`) forced the
   structural detection strategy described in §3. A test simulates a Brototype redeploy by
   randomising every class name; detection still finds 13/13 tasks.
3. **13 tasks, not 12, with mixed nesting.** Task 12 nests roman numerals; task 13 runs `a.`–`j.`.
   Both are handled, and nothing about the count is hardcoded.

Two useful stable hooks *were* found: the chips carry real `variant="sem|paper|module"` attributes
and the status carries `status="Assigned"`. Those are used first, with text regexes as the fallback.
