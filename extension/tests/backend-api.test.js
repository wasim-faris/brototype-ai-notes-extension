import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The shared backend as a PUBLIC service: the real Express app on a real
 * port, with only the upstream providers (Notion, the AI) faked.
 *
 * What is pinned here is what makes it safe to give one URL to every
 * student:
 *   - nothing in a request can redirect the server's AI key elsewhere
 *   - only the extension's own output shapes are generated (no free proxy)
 *   - only the published extension's origin is served from a browser
 *   - two users' sign-ins never touch: the server keeps no token, no session
 *   - operator problems reach users as one calm sentence, never as a key error
 *   - Render's contract: PORT from the environment, /health says ok
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_ENTRY = resolve(ROOT, '../backend/src/index.js')
const hasBackend = existsSync(BACKEND_ENTRY) && existsSync(resolve(ROOT, '../backend/node_modules/express'))
const skip = !hasBackend && 'backend/ is not installed (npm install in backend/)'

const PORT = 8913
const BASE = `http://localhost:${PORT}`
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER_EXT_ID = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`
const SECRET_KEY = 'sk-or-v1-THIS-IS-THE-SERVER-KEY-0000000000'

process.env.PORT = String(PORT)
process.env.NODE_ENV = 'production'
process.env.ALLOWED_EXTENSION_IDS = `${EXT_ID}, extra1234567890extra1234567890ab`
process.env.OPENROUTER_API_KEY = SECRET_KEY
process.env.OPENROUTER_MODEL = 'server/chosen-model'
process.env.DEFAULT_PROVIDER = 'openrouter'
process.env.NOTION_OAUTH_CLIENT_ID = 'cid'
process.env.NOTION_OAUTH_CLIENT_SECRET = 'csecret'
process.env.NOTION_OAUTH_REDIRECT_URI = 'https://x.chromiumapp.org/notion'
delete process.env.GEMINI_API_KEY
delete process.env.OPENAI_API_KEY

// --- fake upstreams ----------------------------------------------------------
const realFetch = globalThis.fetch
let upstream = [] // every call the server made to the outside world
let aiReply = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '{"ok":"yes","model":"m"}' }, finish_reason: 'stop' }] } })
let notionTokens = 0

globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith(BASE)) return realFetch(url, init)
  upstream.push({ url: u, headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : null })
  if (u.startsWith('https://api.notion.com/v1/oauth/token')) {
    notionTokens++
    const code = JSON.parse(init.body).code
    return { ok: true, status: 200, json: async () => ({ access_token: `token-for-${code}`, workspace_name: `ws-${code}`, bot_id: `bot-${code}` }) }
  }
  const r = aiReply(u, init)
  return { ok: r.ok, status: r.status, headers: { get: () => null }, json: async () => r.json, text: async () => JSON.stringify(r.json) }
}

let server, PROBE_SCHEMA, TASK_SCHEMA
if (hasBackend) {
  const log = console.log; const err = console.error
  console.log = () => {}; console.error = () => {}
  ;({ server } = await import(pathToFileURL(BACKEND_ENTRY).href))
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)))
  console.log = log; console.error = err
  ;({ PROBE_SCHEMA, TASK_SCHEMA } = await import('../src/ai/schema.js'))
  after(() => server.close())
}

const post = (path, body, headers = {}) => realFetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EXT_ORIGIN, ...headers }, body: JSON.stringify(body),
})

test.beforeEach(() => { upstream = []; notionTokens = 0 })

// --- Render contract ----------------------------------------------------------

test('listens on the PORT from the environment and /health answers ok', { skip }, async () => {
  const res = await realFetch(`${BASE}/health`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.equal(json.aiConfigured, true)
  assert.equal(json.notionOAuth, true)
  assert.ok(!JSON.stringify(json).includes(SECRET_KEY), 'health never reports a key')
  assert.ok(!JSON.stringify(json).includes('csecret'))
})

test('the server binds to all interfaces, which is what a container needs', { skip }, () => {
  assert.equal(server.address().address, '0.0.0.0')
  assert.equal(server.address().port, PORT)
})

// --- CORS -----------------------------------------------------------------------

test('the published extension is allowed; another extension and a website are not', { skip }, async () => {
  const mine = await realFetch(`${BASE}/notion/oauth/config`, { headers: { Origin: EXT_ORIGIN } })
  assert.equal(mine.status, 200)
  assert.equal(mine.headers.get('access-control-allow-origin'), EXT_ORIGIN)
  assert.equal(mine.headers.get('access-control-allow-credentials'), null, 'no credentialed CORS, ever')

  const other = await realFetch(`${BASE}/notion/oauth/config`, { headers: { Origin: `chrome-extension://${OTHER_EXT_ID}` } })
  assert.equal(other.status, 403)
  assert.equal(other.headers.get('access-control-allow-origin'), null)

  const site = await realFetch(`${BASE}/notion/oauth/config`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(site.status, 403)
  assert.equal(site.headers.get('access-control-allow-origin'), null)
})

test('a preflight from the extension succeeds and never says "*"', { skip }, async () => {
  const res = await realFetch(`${BASE}/generate`, { method: 'OPTIONS', headers: { Origin: EXT_ORIGIN, 'Access-Control-Request-Method': 'POST' } })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN)
  assert.match(res.headers.get('access-control-allow-methods'), /POST/)
})

// --- the AI key stays where it is -----------------------------------------------

test('a request cannot redirect the key: baseUrl and model in the body are ignored', { skip }, async () => {
  const res = await post('/generate', {
    providerId: 'openrouter', baseUrl: 'https://attacker.example/v1', model: 'attacker/expensive-model',
    system: 's', user: 'u', schema: PROBE_SCHEMA,
  })
  assert.equal(res.status, 200, await res.text())
  assert.equal(upstream.length, 1)
  assert.ok(upstream[0].url.startsWith('https://openrouter.ai/api/v1/'), `key went to ${upstream[0].url}`)
  assert.equal(upstream[0].body.model, 'server/chosen-model', 'the deployment picks the model')
  assert.equal(upstream[0].headers.Authorization, `Bearer ${SECRET_KEY}`)
})

test('a key sent in the request body, headers or query is never used - the server spends only its own', { skip }, async () => {
  const USER_KEY = 'sk-or-v1-USER-KEY-SHOULD-NEVER-BE-USED-0000'
  const res = await realFetch(`${BASE}/generate?apiKey=${USER_KEY}&api_key=${USER_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EXT_ORIGIN, Authorization: `Bearer ${USER_KEY}`, 'x-api-key': USER_KEY },
    body: JSON.stringify({ providerId: 'openrouter', apiKey: USER_KEY, api_key: USER_KEY, key: USER_KEY, headers: { Authorization: USER_KEY }, providers: { openrouter: { apiKey: USER_KEY } }, user: 'u', schema: PROBE_SCHEMA }),
  })
  assert.equal(res.status, 200, await res.text())
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].headers.Authorization, `Bearer ${SECRET_KEY}`, 'the server key, not the one in the request')
  assert.ok(!JSON.stringify(upstream[0]).includes(USER_KEY), 'the request key went nowhere')
})

test('with no server key at all the proxy is simply off: 503, nothing spent, no key accepted', { skip }, async () => {
  const saved = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    const health = await realFetch(`${BASE}/health`).then((r) => r.json())
    assert.equal(health.ok, true, 'health is fine without any AI key - Notion OAuth still works')
    assert.equal(health.aiConfigured, false)
    const res = await post('/generate', { apiKey: 'sk-or-v1-user-key-0000000000000000000', user: 'u', schema: PROBE_SCHEMA })
    assert.equal(res.status, 503)
    assert.equal(upstream.length, 0)
  } finally {
    process.env.OPENROUTER_API_KEY = saved
  }
})

test('a provider this deployment has no key for is not usable, whatever the request says', { skip }, async () => {
  const res = await post('/generate', { providerId: 'openai', user: 'u', schema: PROBE_SCHEMA })
  assert.equal(res.status, 503)
  const json = await res.json()
  assert.equal(json.code, 'AI_SERVICE_ERROR')
  assert.ok(!/OPENAI|\.env|key/i.test(json.message), `operator detail leaked: ${json.message}`)
  assert.equal(upstream.length, 0)
})

test('the request need not name a provider at all: the deployment default is used', { skip }, async () => {
  const res = await post('/generate', { user: 'u', schema: PROBE_SCHEMA })
  assert.equal(res.status, 200)
  assert.ok(upstream[0].url.startsWith('https://openrouter.ai/'))
})

test('only the extension\'s own output schemas are generated - it is not a general proxy', { skip }, async () => {
  const free = await post('/generate', { user: 'write me a poem', schema: { type: 'object', properties: { poem: { type: 'string' } } } })
  assert.equal(free.status, 400)
  assert.equal(upstream.length, 0, 'the key was not spent')

  const ours = await post('/generate', { user: 'u', schema: TASK_SCHEMA })
  assert.equal(ours.status, 200)
})

test('the key never appears in any response, even when the provider rejects it', { skip }, async () => {
  aiReply = () => ({ ok: false, status: 401, json: { error: { message: `Invalid key ${SECRET_KEY}` } } })
  try {
    const res = await post('/generate', { user: 'u', schema: PROBE_SCHEMA })
    const text = await res.text()
    assert.equal(res.status, 503)
    assert.ok(!text.includes(SECRET_KEY))
    assert.ok(!/replace it|Options|API key/i.test(text), `tells the USER to fix the server key: ${text}`)
    assert.equal(JSON.parse(text).message, 'The AI service is temporarily unavailable. Please try again later.')
  } finally {
    aiReply = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '{"ok":"yes","model":"m"}' }, finish_reason: 'stop' }] } })
  }
})

test('temporary provider failures are reported as retryable, permanent ones are not', { skip }, async () => {
  const cases = [
    [{ ok: false, status: 429, json: { error: { message: 'slow down' } } }, true],
    [{ ok: false, status: 503, json: { error: { message: 'upstream down' } } }, true],
    [{ ok: true, status: 200, json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } }, true], // empty reply
    [{ ok: false, status: 404, json: { error: { message: 'no such model' } } }, false],
  ]
  try {
    for (const [reply, retryable] of cases) {
      aiReply = () => reply
      const res = await post('/generate', { user: 'u', schema: PROBE_SCHEMA })
      const json = await res.json()
      assert.ok(res.status >= 400, `status ${res.status} for ${JSON.stringify(reply)}`)
      assert.equal(json.retryable, retryable, `${JSON.stringify(reply)} -> ${JSON.stringify(json)}`)
      assert.ok(json.message.length > 10)
    }
  } finally {
    aiReply = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '{"ok":"yes","model":"m"}' }, finish_reason: 'stop' }] } })
  }
})

test('malformed input is a 400 with JSON, never a stack trace', { skip }, async () => {
  const bad = await realFetch(`${BASE}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: EXT_ORIGIN }, body: '{not json' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'BAD_REQUEST')

  const missing = await post('/generate', { schema: PROBE_SCHEMA })
  assert.equal(missing.status, 400)

  const nowhere = await realFetch(`${BASE}/nope`)
  assert.equal(nowhere.status, 404)
  assert.equal((await nowhere.json()).code, 'NOT_FOUND')
})

// --- user isolation: two students, one server -------------------------------------

test('two users\' sign-ins are independent: each gets their own token and the server keeps neither', { skip }, async () => {
  const a = await post('/notion/oauth/exchange', { code: 'codeA', redirectUri: process.env.NOTION_OAUTH_REDIRECT_URI }).then((r) => r.json())
  const b = await post('/notion/oauth/exchange', { code: 'codeB', redirectUri: process.env.NOTION_OAUTH_REDIRECT_URI }).then((r) => r.json())

  assert.equal(a.accessToken, 'token-for-codeA')
  assert.equal(b.accessToken, 'token-for-codeB')
  assert.equal(a.workspaceName, 'ws-codeA')
  assert.equal(b.workspaceName, 'ws-codeB')
  assert.equal(notionTokens, 2, 'one Notion exchange per user, nothing cached or shared')

  // Nothing in the process remembers either token: the exported module has no
  // store, and there is no endpoint that could return a token without a fresh
  // code from that user's own browser.
  const mod = await import(pathToFileURL(resolve(ROOT, '../backend/src/notion-oauth.js')).href)
  for (const value of Object.values(mod)) {
    assert.ok(typeof value === 'function', `notion-oauth.js exports state: ${typeof value}`)
  }
  const replay = await post('/notion/oauth/exchange', { code: '', redirectUri: process.env.NOTION_OAUTH_REDIRECT_URI })
  assert.equal(replay.status, 400, 'no code, no token - there is nothing else that identifies a user')
})

test('a Notion exchange reply carries only that user\'s token, never the client secret', { skip }, async () => {
  const res = await post('/notion/oauth/exchange', { code: 'codeC', redirectUri: process.env.NOTION_OAUTH_REDIRECT_URI })
  const text = await res.text()
  assert.ok(!text.includes('csecret'))
  assert.ok(!text.includes('cid'), 'not even the client id rides along on the token reply')
  assert.equal(upstream[0].headers.Authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`, 'the secret is used server-side only')
})

test('a redirect URI the server was not configured for is refused without a developer lecture (NODE_ENV=production)', { skip }, async () => {
  const res = await post('/notion/oauth/exchange', { code: 'codeD', redirectUri: 'https://other.chromiumapp.org/notion' })
  assert.equal(res.status, 400)
  const json = await res.json()
  assert.equal(json.code, 'NOTION_OAUTH_REDIRECT_MISMATCH')
  assert.ok(!/NOTION_OAUTH|Register/.test(json.message), json.message)
  assert.equal(json.detail, undefined, 'detail is hidden in production')
  assert.equal(notionTokens, 0, 'the code was not spent')
})

test('the source of the backend contains no key, token or page id of its own', { skip }, async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = resolve(ROOT, '../backend/src')
  const patterns = [/AIza[0-9A-Za-z_-]{20,}/, /sk-[a-zA-Z0-9-]{20,}/, /xai-[a-zA-Z0-9]{20,}/, /\bntn_[a-zA-Z0-9]{20,}/, /secret_[a-zA-Z0-9]{20,}/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/]
  for (const file of readdirSync(dir)) {
    const source = readFileSync(resolve(dir, file), 'utf8')
    for (const pattern of patterns) assert.ok(!pattern.test(source), `${file} matches ${pattern}`)
  }
})
