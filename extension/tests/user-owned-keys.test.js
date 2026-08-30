import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every user brings their own AI key. This file pins the properties that make
 * that safe to publish:
 *
 *   - a fresh install is direct mode, OpenRouter selected, no key anywhere
 *   - every provider in the registry can be chosen and given its own key
 *   - a request carries exactly the SELECTED provider's key, to that provider's
 *     host, in a header - never in the URL, never to the backend
 *   - switching providers switches keys; the previous key stays saved
 *   - nothing in source or the shipped code contains a key
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A fake chrome.storage, the only browser API the config layer needs.
const local = new Map()
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (local.has(k) ? { [k]: local.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) local.set(k, v) },
      remove: async (k) => { local.delete(k) },
    },
  },
}

// A fake network that records every request and answers like each provider.
let requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : null })
  const u = String(url)
  let json
  if (u.includes('generativelanguage')) json = { candidates: [{ content: { parts: [{ text: '{"ok":"yes","model":"g"}' }] }, finishReason: 'STOP' }] }
  else if (u.includes('anthropic')) json = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_study_notes', input: { ok: 'yes', model: 'c' } }] }
  else json = { choices: [{ message: { content: '{"ok":"yes","model":"m"}' }, finish_reason: 'stop' }] }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => json, text: async () => JSON.stringify(json) }
}

const { DEFAULT_CONFIG, getConfig, setConfig, setProviderConfig, configStatus } = await import('../src/lib/storage.js')
const { PROVIDERS, PROVIDER_IDS } = await import('../src/ai/registry.js')
const { getProvider } = await import('../src/ai/provider.js')
const { PROBE_SCHEMA, PROBE_PROMPT } = await import('../src/ai/schema.js')

const KEYS = {
  gemini: 'AIzaUSER-GEMINI-KEY-000000000000000',
  openai: 'sk-USER-OPENAI-KEY-00000000000000000000',
  claude: 'sk-ant-USER-CLAUDE-KEY-0000000000000000',
  grok: 'xai-USER-GROK-KEY-000000000000000000000',
  openrouter: 'sk-or-v1-USER-OPENROUTER-KEY-00000000000',
  custom: 'custom-user-key-000000000000000000000000',
}
const ALL_KEYS = Object.values(KEYS)

test.beforeEach(() => { local.clear(); requests = [] })

// --- 1. fresh install ----------------------------------------------------------

test('a fresh install is direct mode, OpenRouter selected, and holds no key for any provider', async () => {
  assert.equal(DEFAULT_CONFIG.ai.mode, 'direct')
  assert.equal(DEFAULT_CONFIG.ai.activeProvider, 'openrouter')
  for (const id of PROVIDER_IDS) assert.equal(DEFAULT_CONFIG.ai.providers[id].apiKey, '', `${id} ships with a key`)

  const config = await getConfig()                          // what chrome.storage returns on first run
  assert.equal(config.ai.mode, 'direct')
  assert.equal(config.ai.activeProvider, 'openrouter')
  assert.equal(configStatus(config).aiConfigured, false, 'nothing works until the user pastes their own key')
  assert.throws(() => getProvider(config), (e) => e.code === 'AI_NOT_CONFIGURED' && /OpenRouter/.test(e.message) && /AI tab/.test(e.message))
})

// --- 2/3. every provider stays available, each with its own key -------------------

test('every existing provider is still offered, and each accepts its own key', async () => {
  assert.deepEqual(PROVIDER_IDS, ['gemini', 'openai', 'claude', 'grok', 'openrouter', 'custom'])
  for (const id of PROVIDER_IDS) {
    await setProviderConfig(id, { apiKey: KEYS[id], ...(id === 'custom' ? { baseUrl: 'https://my-llm.example/v1', model: 'llama3' } : {}) })
  }
  const stored = local.get('config')                          // what is literally in chrome.storage.local
  for (const id of PROVIDER_IDS) assert.equal(stored.ai.providers[id].apiKey, KEYS[id], `${id} key not saved`)
  assert.equal(configStatus(await getConfig()).aiConfigured, true)
})

// --- 5/6/7/8. the key goes to the selected provider and nowhere else ------------------

test('a request carries only the selected provider\'s key, to that provider\'s own host, in a header', async () => {
  for (const id of PROVIDER_IDS) {
    await setProviderConfig(id, { apiKey: KEYS[id], ...(id === 'custom' ? { baseUrl: 'https://my-llm.example/v1', model: 'llama3' } : {}) })
  }
  for (const id of PROVIDER_IDS) {
    requests = []
    await setConfig({ ai: { mode: 'direct', activeProvider: id } })
    const provider = getProvider(await getConfig())
    assert.equal(provider.mode, 'direct')
    await provider.generateStructured(PROBE_PROMPT, PROBE_SCHEMA)

    assert.equal(requests.length, 1, `${id} made ${requests.length} requests`)
    const [r] = requests
    const expectedHost = new URL(id === 'custom' ? 'https://my-llm.example/v1' : PROVIDERS[id].defaultBaseUrl).host
    assert.equal(new URL(r.url).host, expectedHost, `${id} called ${r.url}`)

    const headerText = JSON.stringify(r.headers)
    assert.ok(headerText.includes(KEYS[id]), `${id}: its own key is not in the headers`)
    for (const other of ALL_KEYS.filter((k) => k !== KEYS[id])) {
      assert.ok(!headerText.includes(other), `${id}: another provider's key was sent`)
      assert.ok(!JSON.stringify(r.body).includes(other), `${id}: another provider's key in the body`)
    }
    assert.ok(!r.url.includes(KEYS[id]), `${id}: key in the URL`)
    assert.ok(!JSON.stringify(r.body).includes(KEYS[id]), `${id}: key in the body`)
    assert.ok(!/onrender|localhost|127\.0\.0\.1/.test(r.url), `${id}: request went to the backend`)
  }
})

test('the user\'s key never reaches the backend, even in backend mode', async () => {
  const { requestBody } = await import('../src/ai/transport.js')
  await setProviderConfig('openrouter', { apiKey: KEYS.openrouter })
  await setConfig({ ai: { mode: 'backend', activeProvider: 'openrouter' } })
  const provider = getProvider(await getConfig())
  const body = requestBody(PROBE_PROMPT, PROBE_SCHEMA, provider.resolved)
  assert.deepEqual(Object.keys(body).sort(), ['providerId', 'schema', 'system', 'user'])
  assert.ok(!JSON.stringify(body).includes(KEYS.openrouter))

  await provider.generateStructured(PROBE_PROMPT, PROBE_SCHEMA)
  const [r] = requests
  assert.ok(!JSON.stringify(r).includes(KEYS.openrouter), 'no key in url, headers or body of the backend call')
  assert.equal(r.headers.Authorization, undefined)
})

// --- 9. switching providers -------------------------------------------------------

test('switching provider switches the key, and the previous key is still saved', async () => {
  await setProviderConfig('openrouter', { apiKey: KEYS.openrouter })
  await setProviderConfig('gemini', { apiKey: KEYS.gemini })

  await setConfig({ ai: { activeProvider: 'gemini' } })
  await getProvider(await getConfig()).generateStructured(PROBE_PROMPT, PROBE_SCHEMA)
  assert.ok(JSON.stringify(requests[0].headers).includes(KEYS.gemini))
  assert.ok(!JSON.stringify(requests[0]).includes(KEYS.openrouter))

  await setConfig({ ai: { activeProvider: 'openrouter' } })
  await getProvider(await getConfig()).generateStructured(PROBE_PROMPT, PROBE_SCHEMA)
  assert.ok(JSON.stringify(requests[1].headers).includes(KEYS.openrouter))
  assert.ok(!JSON.stringify(requests[1]).includes(KEYS.gemini))

  const stored = local.get('config')
  assert.equal(stored.ai.providers.gemini.apiKey, KEYS.gemini, 'switching away does not delete a key')
})

// --- errors name the right provider -----------------------------------------------

test('a rejected key names the provider whose key it is, and asks for the user\'s own key', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { message: 'bad' } }), text: async () => '{"error":{"message":"bad"}}' })
  try {
    for (const [id, label] of [['openrouter', 'OpenRouter'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI']]) {
      await setProviderConfig(id, { apiKey: KEYS[id] })
      await setConfig({ ai: { mode: 'direct', activeProvider: id } })
      await assert.rejects(() => getProvider(local.get('config')).generateStructured(PROBE_PROMPT, PROBE_SCHEMA), (e) => {
        assert.equal(e.code, 'AI_BAD_KEY')
        assert.ok(e.message.startsWith(`${label} rejected your API key`), e.message)
        assert.ok(!/server|Render|backend|service is temporarily/i.test(e.message), 'must not blame a server key')
        assert.ok(!e.message.includes(KEYS[id]), 'the key itself is never in a message')
        return true
      })
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

// --- 8. no key in source or docs ------------------------------------------------------

test('no key of any provider is written into the extension source', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
  const patterns = [/AIza[0-9A-Za-z_-]{20,}/, /sk-or-v1-[a-zA-Z0-9]{10,}/, /sk-ant-[a-zA-Z0-9-]{20,}/, /sk-[a-zA-Z0-9]{32,}/, /xai-[a-zA-Z0-9]{20,}/, /\bntn_[a-zA-Z0-9]{20,}/]
  for (const file of walk(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const p of patterns) assert.ok(!p.test(text), `${file} matches ${p}`)
    assert.ok(!/OPENROUTER_API_KEY/.test(text), `${file} refers to a server-side OpenRouter key`)
  }
})
