import test from 'node:test'
import assert from 'node:assert/strict'
import * as gemini from '../src/ai/gemini.js'
import { buildEndpoint, modelPathSegment } from '../src/ai/gemini.js'
import { resolveProviderConfig } from '../src/ai/provider.js'
import { cleanValue, cleanBaseUrl } from '../src/ai/clean.js'
import { DEFAULT_CONFIG } from '../src/lib/storage.js'
import { PROVIDERS } from '../src/ai/registry.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const MODEL = 'gemini-2.5-flash-lite'
// The exact URL from Google's API reference.
const EXPECTED = `${BASE}/models/${MODEL}:generateContent`

test('REGRESSION: gemini-2.5-flash-lite builds the documented endpoint', () => {
  assert.equal(buildEndpoint(BASE, MODEL), EXPECTED)
})

test('REGRESSION: every way that model name gets pasted reaches the same URL', () => {
  const variants = [
    MODEL,
    `models/${MODEL}`,          // how Google's docs print full model paths
    `/models/${MODEL}`,
    `  ${MODEL}  `,             // stray whitespace
    `"${MODEL}"`,               // copied with quotes
    `${MODEL}​`,           // zero-width space - survives String.trim()
    `﻿${MODEL}`,           // byte-order mark
    `${MODEL} `,           // non-breaking space
    `${MODEL}\n`,
  ]
  for (const variant of variants) {
    assert.equal(buildEndpoint(BASE, variant), EXPECTED, `failed for ${JSON.stringify(variant)}`)
  }
})

test('REGRESSION: the model id is never percent-encoded into nonsense', () => {
  // The original bug: encodeURIComponent turned a "models/" prefix into "%2F",
  // producing a URL that 404s with an empty body and no explanation.
  const url = buildEndpoint(BASE, `models/${MODEL}`)
  assert.ok(!url.includes('%2F'), url)
  assert.ok(!url.includes('%20'), url)
  assert.ok(!url.includes('%E2%80%8B'), url)
  assert.equal(url.split('/models/').length, 2, 'exactly one /models/ segment')
})

test('REGRESSION: an empty model throws instead of building /models/:generateContent', () => {
  // This URL is what produced the original bare 404 with an empty body.
  for (const empty of ['', '   ', 'models/', '​', null, undefined]) {
    assert.throws(() => buildEndpoint(BASE, empty), (e) => e.code === 'AI_NOT_CONFIGURED',
      `should have thrown for ${JSON.stringify(empty)}`)
  }
})

test('a malformed model name gets its OWN code, never the upstream-404 one', () => {
  assert.throws(() => modelPathSegment('gemini 2.5 flash lite'), (e) => {
    // Must NOT be AI_BAD_MODEL: that code means "the server replied 404", and
    // conflating the two is what produced a self-contradictory error message.
    assert.equal(e.code, 'AI_INVALID_MODEL_NAME')
    assert.match(e.message, /gemini 2\.5 flash lite/)
    return true
  })
})

test('the base URL is accepted with or without a trailing slash or /models', () => {
  for (const base of [BASE, `${BASE}/`, `${BASE}//`, `${BASE}/models`, `${BASE}/models/`, ` ${BASE} `]) {
    assert.equal(buildEndpoint(base, MODEL), EXPECTED, `failed for ${JSON.stringify(base)}`)
  }
})

test('an empty base URL throws instead of requesting a relative path', () => {
  assert.throws(() => buildEndpoint('', MODEL), (e) => e.code === 'AI_NOT_CONFIGURED')
})

test('config resolution strips invisible characters before the adapter sees them', () => {
  const config = {
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      activeProvider: 'gemini',
      providers: {
        ...DEFAULT_CONFIG.ai.providers,
        gemini: { apiKey: ' AIza-key​ ', model: `​${MODEL} `, baseUrl: ` ${BASE}/ ` },
      },
    },
  }
  const resolved = resolveProviderConfig(config)
  assert.equal(resolved.model, MODEL)
  assert.equal(resolved.baseUrl, BASE)
  assert.equal(resolved.apiKey, 'AIza-key', 'a pasted key must not carry invisible characters either')
})

test('cleanValue removes what trim() cannot', () => {
  assert.equal('x​'.trim(), 'x​', 'this is why trim alone was not enough')
  assert.equal(cleanValue('x​'), 'x')
  assert.equal(cleanValue(' x﻿'), 'x')
  assert.equal(cleanBaseUrl('https://a.example/v1//'), 'https://a.example/v1')
})

test('every model offered in the UI builds a valid URL', () => {
  for (const model of PROVIDERS.gemini.modelSuggestions) {
    assert.doesNotThrow(() => buildEndpoint(PROVIDERS.gemini.defaultBaseUrl, model), `bad suggestion: ${model}`)
  }
  assert.ok(PROVIDERS.gemini.modelSuggestions.includes(PROVIDERS.gemini.defaultModel),
    'the default model should also be offered in the dropdown')
})

test('no retired model is offered as a default or suggestion', () => {
  // Confirmed against the live API: the whole gemini-2.5-* family answers
  // 404 "no longer available to new users" for recently created keys.
  const retired = /^gemini-2\.\d/
  assert.ok(!retired.test(PROVIDERS.gemini.defaultModel), `default is retired: ${PROVIDERS.gemini.defaultModel}`)
  for (const model of PROVIDERS.gemini.modelSuggestions) {
    assert.ok(!retired.test(model), `retired model still suggested: ${model}`)
  }
})

// --- the error the user actually saw --------------------------------------

function stubFetch(reply) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      headers: new Map(),
      text: async () => reply.text ?? JSON.stringify(reply.body ?? {}),
      json: async () => reply.body ?? {},
    }
  }
  return calls
}

/** A successful generateContent response carrying `obj` as its JSON payload. */
const geminiReply = (obj) => ({
  body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] },
})

const geminiConfig = (over = {}) => ({
  id: 'gemini',
  label: 'Google Gemini',
  capabilities: PROVIDERS.gemini.capabilities,
  maxOutputTokens: 1024,
  model: MODEL,
  baseUrl: BASE,
  apiKey: 'AIza-test',
  meta: PROVIDERS.gemini,
  ...over,
})

test.afterEach(() => { delete globalThis.fetch })

test('REGRESSION: a 404 with an empty body still explains itself', async () => {
  // This is the exact upstream response that produced the unhelpful message.
  stubFetch({ status: 404, text: '' })

  await assert.rejects(
    () => gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' }, geminiConfig()),
    (e) => {
      assert.equal(e.code, 'AI_BAD_MODEL')
      assert.match(e.message, /gemini-2\.5-flash-lite/, 'must name the model it tried')
      assert.match(e.message, /generativelanguage\.googleapis\.com/, 'must name the base URL it tried')
      assert.match(e.message, /no explanation/, 'must say the server gave no reason')
      assert.match(e.detail, /^POST https:\/\/.*:generateContent$/, 'detail must carry the exact URL')
      return true
    },
  )
})

test("REGRESSION: a 404 that carries Google's message repeats it verbatim", async () => {
  // The message that actually broke this for real: Google names the fix, and an
  // earlier version of testConnection threw that away and substituted a list.
  const googleSays = 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features and improvements.'
  stubFetch({ status: 404, body: { error: { message: googleSays } } })

  await assert.rejects(
    () => gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' }, geminiConfig({ model: 'gemini-2.5-flash' })),
    (e) => {
      assert.ok(e.message.includes(googleSays), 'Google\'s own words must survive intact')
      assert.match(e.message, /gemini-3\.6-flash/, 'so the replacement model reaches the user')
      assert.equal(e.upstreamExplained, true)
      return true
    },
  )
})

test('REGRESSION: Test Connection does not bury an explained 404 under a model list', async () => {
  const googleSays = 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash.'
  let networkCalls = 0
  globalThis.fetch = async () => {
    networkCalls++
    return {
      ok: false, status: 404, headers: new Map(),
      text: async () => JSON.stringify({ error: { message: googleSays } }),
    }
  }

  await assert.rejects(
    () => gemini.testConnection(geminiConfig({ model: 'gemini-2.5-flash' })),
    (e) => {
      assert.ok(e.message.includes(googleSays), 'must keep the explanation')
      assert.ok(!/Models the API lists/.test(e.message), 'must not append a contradicting list')
      return true
    },
  )
  assert.equal(networkCalls, 1, 'no ListModels probe when Google already explained itself')
})

test('on a model 404, Test Connection lists the models the key can actually use', async () => {
  let call = 0
  globalThis.fetch = async (url) => {
    call++
    if (call === 1) {
      return { ok: false, status: 404, headers: new Map(), text: async () => '' }
    }
    // The follow-up ListModels probe.
    assert.match(url, /\/models\?pageSize=200$/)
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    }
  }

  await assert.rejects(
    () => gemini.testConnection(geminiConfig({ model: 'gemini-typo' })),
    (e) => {
      assert.equal(e.code, 'AI_BAD_MODEL')
      assert.match(e.message, /gemini-2\.5-flash/, 'should list a usable model')
      assert.ok(!e.message.includes('text-embedding-004'), 'must not offer a model that cannot generate')
      return true
    },
  )
  assert.equal(call, 2, 'should have probed ListModels exactly once')
})

test('a bad key during Test Connection is reported as a bad key, not a bad model', async () => {
  stubFetch({ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } })
  await assert.rejects(() => gemini.testConnection(geminiConfig()), (e) => e.code === 'AI_BAD_KEY')
})


// --- the exact URL, as specified ------------------------------------------

const DOCUMENTED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

test('SPEC: baseURL + model produce exactly the documented request URL', () => {
  assert.equal(
    buildEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'),
    DOCUMENTED_URL,
  )
})

test('SPEC: none of the known malformed shapes can be produced', () => {
  const url = buildEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash')
  const forbidden = [
    '/v1beta/gemini-2.5-flash',            // model not under /models/
    '/models/models/',                     // duplicated prefix
    '/models/gemini-2.5-flash/models/',    // model path repeated
    '%2F', '%20', '%E2%80%8B',             // percent-encoded junk
    '?model=', '&model=',                  // model smuggled into a query
  ]
  for (const bad of forbidden) {
    assert.ok(!url.includes(bad), `URL contains "${bad}": ${url}`)
  }
  assert.equal(url.split('/models/').length, 2, 'exactly one /models/ segment')
  assert.equal(url.split(':generateContent').length, 2, 'exactly one method suffix')
})

test('SPEC: the model travels in the PATH, never in the query string or body', async () => {
  const calls = stubFetch(geminiReply({ ok: 'ok', model: 'gemini-2.5-flash' }))
  await gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' }, geminiConfig({ model: 'gemini-2.5-flash' }))

  const [call] = calls
  assert.equal(call.url, DOCUMENTED_URL)

  const body = JSON.parse(call.init.body)
  assert.ok(!('model' in body), 'the model must not be a body field')
  assert.ok(!call.url.includes('?'), 'the model must not be a query parameter')
  assert.ok(!call.url.includes('key='), 'the API key must never be in the URL')
  assert.equal(call.init.headers['x-goog-api-key'], 'AIza-test', 'the key goes in the documented header')
  assert.equal(call.init.method, 'POST')
})

test('SPEC: generation and Test Connection hit the identical URL', async () => {
  const genCalls = stubFetch(geminiReply({ ok: 'ok', model: 'x' }))
  await gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' }, geminiConfig({ model: 'gemini-2.5-flash' }))

  const testCalls = stubFetch(geminiReply({ ok: 'ok', model: 'x' }))
  await gemini.testConnection(geminiConfig({ model: 'gemini-2.5-flash' }))

  assert.equal(testCalls[0].url, genCalls[0].url)
  assert.equal(testCalls[0].url, DOCUMENTED_URL)
})

// --- the bug that produced the self-contradictory message -----------------

test('REGRESSION: a locally-invalid model never becomes "Google has no such model"', async () => {
  // The old code caught AI_BAD_MODEL from LOCAL validation, ran the ListModels
  // probe anyway, and reported "has no model X. Models you can use include: X"
  // - both wrong and self-contradicting, with the real reason discarded.
  let networkCalls = 0
  globalThis.fetch = async () => {
    networkCalls++
    return {
      ok: true, status: 200, headers: new Map(), text: async () => '{}',
      json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }),
    }
  }

  await assert.rejects(
    () => gemini.testConnection(geminiConfig({ model: 'gemini-2.5 flash' })),
    (e) => {
      assert.equal(e.code, 'AI_INVALID_MODEL_NAME', 'must keep the local error code')
      assert.ok(!/Models your API key can use/.test(e.message), 'must not run the availability probe')
      assert.ok(!/has no model/.test(e.message), 'must not blame Google')
      assert.match(e.message, /not usable/)
      return true
    },
  )
  assert.equal(networkCalls, 0, 'a locally-invalid name must not hit the network at all')
})

test('REGRESSION: a look-alike character is SHOWN in the error, not hidden', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called') }

  // An en-dash (U+2013) is visually identical to a hyphen in most fonts, and
  // word processors and web pages substitute it automatically. Left unrendered,
  // "gemini-2.5-flash is not a valid model name" reads as nonsense.
  await assert.rejects(
    () => gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' },
      geminiConfig({ model: 'gemini–2.5-flash' })),
    (e) => {
      assert.equal(e.code, 'AI_INVALID_MODEL_NAME')
      assert.match(e.message, /\\u2013/, 'the offending character must be spelled out')
      assert.match(e.message, /only look like ordinary ones/)
      return true
    },
  )
})

test('a non-breaking space is normalised, so the error points at the space itself', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called') }
  await assert.rejects(
    () => gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' },
      geminiConfig({ model: 'gemini-2.5 flash' })),
    (e) => {
      assert.match(e.message, /"gemini-2\.5 flash"/, 'shown as an ordinary space, which is what it now is')
      assert.match(e.message, /may only contain letters/)
      return true
    },
  )
})

test('an UNEXPLAINED upstream 404 still gets the availability probe', async () => {
  let call = 0
  globalThis.fetch = async () => {
    call++
    if (call === 1) return { ok: false, status: 404, headers: new Map(), text: async () => '' }
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }),
    }
  }

  await assert.rejects(
    () => gemini.testConnection(geminiConfig({ model: 'gemini-does-not-exist' })),
    (e) => {
      assert.equal(e.code, 'AI_BAD_MODEL')
      assert.match(e.message, /gave no reason/)
      assert.match(e.message, /gemini-2\.5-flash/, 'lists what the API reported')
      assert.match(e.message, /some listed models are retired/, 'and hedges, because ListModels over-reports')
      return true
    },
  )
  assert.equal(call, 2, 'one generateContent attempt, then one ListModels probe')
})

test('every network failure records the exact URL requested', async () => {
  stubFetch({ status: 500, body: { error: { message: 'boom' } } })
  await assert.rejects(
    () => gemini.generateStructured({ system: 's', user: 'u' }, { type: 'object' }, geminiConfig()),
    (e) => {
      assert.equal(e.sentRequest, true, 'must be marked as having reached the server')
      assert.equal(e.requestUrl, `${BASE}/models/${MODEL}:generateContent`)
      return true
    },
  )
})

test('an invisible character in a stored model self-heals instead of failing', () => {
  // resolveProviderConfig cleans first, so an already-saved bad value repairs
  // itself on read - no retyping needed for the characters we know about.
  const config = {
    ...DEFAULT_CONFIG,
    ai: {
      ...DEFAULT_CONFIG.ai,
      activeProvider: 'gemini',
      providers: {
        ...DEFAULT_CONFIG.ai.providers,
        gemini: { apiKey: 'k', model: '﻿gemini-2.5-flash​', baseUrl: '' },
      },
    },
  }
  const resolved = resolveProviderConfig(config)
  assert.equal(resolved.model, 'gemini-2.5-flash')
  assert.equal(buildEndpoint(resolved.baseUrl, resolved.model), DOCUMENTED_URL)
})
