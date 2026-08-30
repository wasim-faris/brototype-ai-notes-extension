import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, PROVIDER_IDS, blankProviderConfig } from '../src/ai/registry.js'
import { resolveProviderConfig, validateProviderConfig, getProvider } from '../src/ai/provider.js'
import { TASK_SCHEMA, toGeminiSchema, toStrictJsonSchema, schemaToPromptText } from '../src/ai/schema.js'
import { extractJson } from '../src/ai/json.js'
import { migrateConfig, DEFAULT_CONFIG } from '../src/lib/storage.js'

/** A config the way getConfig() would return it, without needing chrome APIs. */
const makeConfig = (ai = {}) => ({
  ...DEFAULT_CONFIG,
  ai: {
    ...DEFAULT_CONFIG.ai,
    ...ai,
    providers: { ...DEFAULT_CONFIG.ai.providers, ...(ai.providers || {}) },
  },
})

// --- registry -------------------------------------------------------------

test('every provider in the registry is complete and points at a real adapter', () => {
  const adapters = new Set(['gemini', 'openai-compatible', 'claude'])
  for (const id of PROVIDER_IDS) {
    const meta = PROVIDERS[id]
    assert.ok(meta.label, `${id} has no label`)
    assert.ok(adapters.has(meta.adapter), `${id} points at unknown adapter "${meta.adapter}"`)
    assert.ok(meta.capabilities.structuredOutput, `${id} declares no structuredOutput mechanism`)
    assert.ok(meta.capabilities.maxOutputTokens > 0, `${id} has no output budget`)
    assert.ok(meta.requestsPerMinute > 0, `${id} has no rate`)
    // Only "custom" may ship without a base URL, because the user supplies it.
    if (id !== 'custom') assert.ok(meta.defaultBaseUrl, `${id} has no default base URL`)
  }
})

test('the requested providers are all present, OpenRouter included', () => {
  assert.deepEqual(PROVIDER_IDS, ['gemini', 'openai', 'claude', 'grok', 'openrouter', 'custom'])
})

test('OpenRouter is a real entry, not an alias of custom', () => {
  assert.equal(PROVIDERS.openrouter.adapter, 'openai-compatible')
  assert.equal(PROVIDERS.openrouter.defaultBaseUrl, 'https://openrouter.ai/api/v1')
  assert.match(PROVIDERS.openrouter.defaultModel, /:free$/, 'default must cost nothing')
  assert.equal(PROVIDERS.openrouter.capabilities.structuredOutput, 'auto', 'a router must probe, not assume')
  assert.ok(PROVIDERS.openrouter.requestsPerMinute <= 20, 'free tier is ~20 rpm')
})

// --- resolution -----------------------------------------------------------

test('each provider resolves to its own settings, not another provider\'s', () => {
  const config = makeConfig({
    activeProvider: 'grok',
    providers: {
      gemini: { apiKey: 'AIza-gemini', model: 'gemini-2.5-flash', baseUrl: '' },
      grok: { apiKey: 'xai-grok', model: 'grok-4', baseUrl: '' },
    },
  })

  const grok = resolveProviderConfig(config)
  assert.equal(grok.id, 'grok')
  assert.equal(grok.apiKey, 'xai-grok')
  assert.equal(grok.model, 'grok-4')
  assert.equal(grok.baseUrl, 'https://api.x.ai/v1')

  // Switching the active provider must not disturb the other stored config.
  const gemini = resolveProviderConfig(config, 'gemini')
  assert.equal(gemini.apiKey, 'AIza-gemini')
  assert.equal(gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta')
})

test('an empty saved baseUrl follows the registry, a set one overrides it', () => {
  const withDefault = resolveProviderConfig(makeConfig({ providers: { gemini: { apiKey: 'k', model: 'm', baseUrl: '' } } }), 'gemini')
  assert.equal(withDefault.baseUrl, PROVIDERS.gemini.defaultBaseUrl)

  const overridden = resolveProviderConfig(makeConfig({ providers: { gemini: { apiKey: 'k', model: 'm', baseUrl: 'http://localhost:1234/v1beta' } } }), 'gemini')
  assert.equal(overridden.baseUrl, 'http://localhost:1234/v1beta')
})

test('validation explains exactly what is missing', () => {
  const noKey = resolveProviderConfig(makeConfig({ activeProvider: 'openai' }))
  assert.match(validateProviderConfig(noKey), /No API key is saved for OpenAI/)

  const noUrl = resolveProviderConfig(makeConfig({ activeProvider: 'custom', providers: { custom: { apiKey: 'k', model: 'm', baseUrl: '' } } }))
  assert.match(validateProviderConfig(noUrl), /No API base URL is set/)

  const ok = resolveProviderConfig(makeConfig({ activeProvider: 'claude', providers: { claude: { apiKey: 'sk-ant-x', model: 'claude-sonnet-5', baseUrl: '' } } }))
  assert.equal(validateProviderConfig(ok), null)
})

test('a local server with no key is allowed, because "custom" marks the key optional', () => {
  const resolved = resolveProviderConfig(makeConfig({
    activeProvider: 'custom',
    providers: { custom: { apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1' } },
  }))
  assert.equal(validateProviderConfig(resolved), null)
})

test('getProvider gives the same interface for every provider and both modes', () => {
  // Direct mode has to be asked for: a fresh install talks to the shared backend.
  const cases = [
    ['gemini', { apiKey: 'AIza', model: 'gemini-2.5-flash' }],
    ['openai', { apiKey: 'sk-x', model: 'gpt-4.1-mini' }],
    ['claude', { apiKey: 'sk-ant-x', model: 'claude-sonnet-5' }],
    ['grok', { apiKey: 'xai-x', model: 'grok-4-fast' }],
    ['custom', { apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }],
  ]

  for (const [id, saved] of cases) {
    const provider = getProvider(makeConfig({ mode: 'direct', activeProvider: id, providers: { [id]: { baseUrl: '', ...saved } } }))
    assert.equal(typeof provider.generateStructured, 'function', `${id} direct`)
    assert.equal(typeof provider.testConnection, 'function', `${id} direct`)
    assert.equal(provider.mode, 'direct')
    assert.match(provider.describe(), new RegExp(saved.model))
  }
})

test('backend mode works for every provider, and needs no local key', () => {
  for (const id of PROVIDER_IDS) {
    const provider = getProvider(makeConfig({ mode: 'backend', activeProvider: id }))
    assert.equal(provider.mode, 'backend')
    assert.match(provider.describe(), /via backend/)
    assert.equal(typeof provider.generateStructured, 'function')
  }
})

test('backend mode with no URL uses the server this build was made for, so nobody has to type one', async () => {
  const { DEFAULT_BACKEND_URL } = await import('../src/lib/env.js')
  const provider = getProvider(makeConfig({ mode: 'backend', backendUrl: '' }))
  assert.equal(provider.resolved.backendUrl, DEFAULT_BACKEND_URL)
  // An explicit override still wins.
  assert.equal(getProvider(makeConfig({ mode: 'backend', backendUrl: 'https://scratch.example' })).resolved.backendUrl, 'https://scratch.example')
})

test('a fresh install is direct mode with OpenRouter selected and no key, so the user\'s own key is the only one that can ever be used', () => {
  assert.equal(DEFAULT_CONFIG.ai.mode, 'direct')
  assert.equal(DEFAULT_CONFIG.ai.activeProvider, 'openrouter')
  assert.equal(DEFAULT_CONFIG.ai.providers.openrouter.apiKey, '')
  assert.throws(() => getProvider(DEFAULT_CONFIG), (e) => e.code === 'AI_NOT_CONFIGURED')
})

test('an unknown provider id is rejected, not silently defaulted', () => {
  assert.throws(() => resolveProviderConfig(makeConfig({ activeProvider: 'nope' })), /Unknown AI provider/)
})

// --- schema dialects ------------------------------------------------------

test('Gemini dialect: uppercase types and explicit property ordering', () => {
  const converted = toGeminiSchema(TASK_SCHEMA)
  assert.equal(converted.type, 'OBJECT')
  assert.equal(converted.properties.topics.type, 'ARRAY')
  const topic = converted.properties.topics.items
  assert.equal(topic.type, 'OBJECT')
  assert.deepEqual(topic.propertyOrdering, ['title', 'sections'])
  const section = topic.properties.sections.items
  assert.equal(section.properties.text.type, 'STRING')
  assert.equal(section.properties.tableRows.type, 'ARRAY')
  assert.equal(section.properties.tableRows.items.items.type, 'STRING', 'nested arrays survive the conversion')
  assert.deepEqual(section.properties.kind.enum, ['text', 'list', 'code', 'table'], 'the enum survives')
  assert.equal(converted.properties.reviewQuestions.minItems, 5)

  // Ordering must survive: heading and kind come before the content fields.
  assert.deepEqual(section.propertyOrdering.slice(0, 2), ['heading', 'kind'])
})

test('OpenAI strict dialect: additionalProperties false, all keys required, no array limits', () => {
  const strict = toStrictJsonSchema(TASK_SCHEMA)

  const walk = (node, path = '$') => {
    if (!node || typeof node !== 'object') return
    assert.ok(!('minItems' in node), `${path} still has minItems, which strict mode rejects`)
    assert.ok(!('maxItems' in node), `${path} still has maxItems`)
    if (node.properties) {
      assert.equal(node.additionalProperties, false, `${path} allows extra properties`)
      assert.deepEqual(node.required, Object.keys(node.properties), `${path} must require every key`)
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`)
    }
    if (node.items) walk(node.items, `${path}[]`)
  }
  walk(strict)

  // Types stay lowercase, unlike the Gemini dialect.
  assert.equal(strict.type, 'object')
})

test('the canonical schema is left untouched by the converters', () => {
  const before = JSON.stringify(TASK_SCHEMA)
  toGeminiSchema(TASK_SCHEMA)
  toStrictJsonSchema(TASK_SCHEMA)
  assert.equal(JSON.stringify(TASK_SCHEMA), before, 'a converter mutated the shared schema')
})

test('Claude gets the plain schema, which is what its tool input_schema expects', () => {
  assert.equal(TASK_SCHEMA.type, 'object')
  assert.ok(Array.isArray(TASK_SCHEMA.required))
})

test('the prompt fallback embeds the schema as text', () => {
  const text = schemaToPromptText(TASK_SCHEMA)
  assert.match(text, /ONLY a JSON object/)
  assert.match(text, /reviewQuestions/)
})

// --- tolerant JSON reading ------------------------------------------------

test('JSON is recovered from fences and preamble, but junk is rejected', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 })
  assert.throws(() => extractJson('I cannot help with that.'), /not return valid JSON/)
  assert.throws(() => extractJson(''), /empty response/)
})

// --- migration ------------------------------------------------------------

test('an old single-Gemini config is migrated, not destroyed', () => {
  const old = {
    notionToken: 'ntn_keepme',
    notionParentId: 'page-123',
    aiProvider: 'gemini',
    geminiApiKey: 'AIza-old-key',
    geminiModel: 'gemini-2.0-flash',
    backendUrl: 'http://localhost:9999',
    duplicateStrategy: 'new',
  }
  const migrated = migrateConfig(old)

  assert.equal(migrated.ai.mode, 'direct')
  assert.equal(migrated.ai.activeProvider, 'gemini')
  assert.equal(migrated.ai.providers.gemini.apiKey, 'AIza-old-key')
  assert.equal(migrated.ai.providers.gemini.model, 'gemini-2.0-flash')
  assert.equal(migrated.ai.backendUrl, 'http://localhost:9999')

  // Unrelated settings survive untouched.
  assert.equal(migrated.notionToken, 'ntn_keepme')
  assert.equal(migrated.duplicateStrategy, 'new')

  // The old flat keys are gone, so nothing reads them by accident.
  assert.ok(!('geminiApiKey' in migrated))
  assert.ok(!('aiProvider' in migrated))
})

test('the old "backend" provider becomes backend MODE, keeping the provider', () => {
  const migrated = migrateConfig({ aiProvider: 'backend', geminiApiKey: 'AIza-x', backendUrl: 'http://localhost:8787' })
  assert.equal(migrated.ai.mode, 'backend')
  assert.equal(migrated.ai.activeProvider, 'gemini')
  assert.equal(migrated.ai.providers.gemini.apiKey, 'AIza-x')
})

test('an already-current config is passed through unchanged', () => {
  const current = { ai: { mode: 'direct', activeProvider: 'grok', providers: { grok: { apiKey: 'x' } } } }
  assert.equal(migrateConfig(current), current)
})

test('every registry provider gets a slot in the default config', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.ai.providers).sort(), [...PROVIDER_IDS].sort())
  assert.deepEqual(blankProviderConfig('grok'), { apiKey: '', model: 'grok-4-fast', baseUrl: '' })
})
