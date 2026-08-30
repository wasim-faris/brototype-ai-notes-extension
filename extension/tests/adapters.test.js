import test from 'node:test'
import assert from 'node:assert/strict'
import * as gemini from '../src/ai/gemini.js'
import * as openai from '../src/ai/openai-compatible.js'
import * as claude from '../src/ai/claude.js'
import { PROVIDERS } from '../src/ai/registry.js'
import { TASK_SCHEMA } from '../src/ai/schema.js'

const PROMPT = { system: 'You write study notes.', user: 'Write notes for useContext.' }
const NOTES = { number: 1, title: 't', summary: 's', topics: [], reviewQuestions: [] }

/** Captures the outgoing request and replies with whatever the test wants. */
function stubFetch(responses) {
  const calls = []
  const queue = Array.isArray(responses) ? [...responses] : [responses]

  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return {
      ok: next.status === undefined || next.status < 400,
      status: next.status ?? 200,
      headers: new Map(),
      text: async () => JSON.stringify(next.body ?? {}),
    }
  }
  return calls
}

const config = (id, over = {}) => ({
  id,
  label: PROVIDERS[id].label,
  capabilities: PROVIDERS[id].capabilities,
  maxOutputTokens: PROVIDERS[id].capabilities.maxOutputTokens,
  model: PROVIDERS[id].defaultModel,
  baseUrl: PROVIDERS[id].defaultBaseUrl,
  apiKey: 'test-key',
  meta: PROVIDERS[id],
  ...over,
})

const geminiReply = (obj) => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] } })
const openaiReply = (obj) => ({ body: { choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }] } })
const claudeReply = (obj) => ({ body: { content: [{ type: 'tool_use', name: 'emit_study_notes', input: obj }], stop_reason: 'tool_use' } })

test.afterEach(() => { delete globalThis.fetch })

// --- Gemini ---------------------------------------------------------------

test('Gemini: correct endpoint, key in a header, uppercase response schema', async () => {
  const calls = stubFetch(geminiReply(NOTES))
  const result = await gemini.generateStructured(PROMPT, TASK_SCHEMA, config('gemini'))

  assert.deepEqual(result, NOTES)
  const [call] = calls
  assert.match(call.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent$/)
  assert.equal(call.init.headers['x-goog-api-key'], 'test-key')
  assert.ok(!call.url.includes('test-key'), 'the key must never appear in the URL')

  assert.equal(call.body.generationConfig.responseMimeType, 'application/json')
  assert.equal(call.body.generationConfig.responseSchema.type, 'OBJECT')
  assert.equal(call.body.systemInstruction.parts[0].text, PROMPT.system)
})

test('Gemini: thinkingBudget is sent ONLY to the 2.5 family', async () => {
  // Verified against the live API: thinkingBudget is a hard 400 on both 2.0 and
  // 3.x. Gemini 3.x uses thinkingLevel instead, and we leave its thinking on.
  let calls = stubFetch(geminiReply(NOTES))
  await gemini.generateStructured(PROMPT, TASK_SCHEMA, config('gemini', { model: 'gemini-2.5-pro' }))
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget, 0)

  for (const model of ['gemini-2.0-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest']) {
    calls = stubFetch(geminiReply(NOTES))
    await gemini.generateStructured(PROMPT, TASK_SCHEMA, config('gemini', { model }))
    assert.ok(!('thinkingConfig' in calls[0].body.generationConfig), `${model} must not receive thinkingConfig`)
  }
})

test('Gemini: a cut-off response raises AI_TRUNCATED so the task gets split', async () => {
  stubFetch({ body: { candidates: [{ content: { parts: [{ text: '{"top' }] }, finishReason: 'MAX_TOKENS' }] } })
  await assert.rejects(
    () => gemini.generateStructured(PROMPT, TASK_SCHEMA, config('gemini')),
    (e) => e.code === 'AI_TRUNCATED',
  )
})

// --- OpenAI / Grok --------------------------------------------------------

test('OpenAI: chat/completions with strict json_schema and a Bearer key', async () => {
  const calls = stubFetch(openaiReply(NOTES))
  const result = await openai.generateStructured(PROMPT, TASK_SCHEMA, config('openai'))

  assert.deepEqual(result, NOTES)
  const [call] = calls
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(call.init.headers.Authorization, 'Bearer test-key')

  assert.equal(call.body.response_format.type, 'json_schema')
  assert.equal(call.body.response_format.json_schema.strict, true)
  assert.equal(call.body.response_format.json_schema.schema.additionalProperties, false)
  assert.equal(call.body.messages[0].role, 'system')
})

test('OpenRouter reuses the same adapter with its own base URL and a free default model', async () => {
  const calls = stubFetch(openaiReply(NOTES))
  await openai.generateStructured(PROMPT, TASK_SCHEMA, config('openrouter'))
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.match(calls[0].body.model, /:free$/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
  // 'auto' starts at the strictest rung and steps down only if the router rejects it.
  assert.equal(calls[0].body.response_format.type, 'json_schema')
})

test('Grok reuses the same adapter but its own base URL and model', async () => {
  const calls = stubFetch(openaiReply(NOTES))
  await openai.generateStructured(PROMPT, TASK_SCHEMA, config('grok'))
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions')
  assert.equal(calls[0].body.model, 'grok-4-fast')
})

test('a declared provider does NOT silently downgrade its structured-output mode', async () => {
  stubFetch({ status: 400, body: { error: { message: 'response_format is not supported' } } })
  // OpenAI declares json_schema support, so a 400 is a real error to report,
  // not a reason to quietly send an unconstrained request.
  await assert.rejects(() => openai.generateStructured(PROMPT, TASK_SCHEMA, config('openai')))
})

test('a custom server that rejects json_schema falls back down the ladder', async () => {
  const calls = stubFetch([
    { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } },
    openaiReply(NOTES),
  ])

  const result = await openai.generateStructured(PROMPT, TASK_SCHEMA,
    config('custom', { baseUrl: 'https://my-llm.example/v1', model: 'local-model' }))

  assert.deepEqual(result, NOTES)
  assert.equal(calls.length, 2, 'should retry once, weaker')
  assert.equal(calls[0].body.response_format.type, 'json_schema')
  assert.equal(calls[1].body.response_format.type, 'json_object')
})

test('a rate limit is never mistaken for an unsupported feature', async () => {
  const calls = stubFetch({ status: 429, body: { error: { message: 'slow down' } } })
  await assert.rejects(
    () => openai.generateStructured(PROMPT, TASK_SCHEMA, config('custom', { baseUrl: 'https://other.example/v1', model: 'm' })),
    (e) => e.code === 'AI_RATE_LIMIT' && e.retryable === true,
  )
  assert.equal(calls.length, 1, 'must not walk the ladder on a rate limit')
})

test('a local server with no key sends no Authorization header', async () => {
  const calls = stubFetch(openaiReply(NOTES))
  await openai.generateStructured(PROMPT, TASK_SCHEMA,
    config('custom', { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }))
  assert.ok(!('Authorization' in calls[0].init.headers))
})

// --- Claude ---------------------------------------------------------------

test('Claude: structured output via a FORCED tool call, not response_format', async () => {
  const calls = stubFetch(claudeReply(NOTES))
  const result = await claude.generateStructured(PROMPT, TASK_SCHEMA, config('claude'))

  assert.deepEqual(result, NOTES)
  const [call] = calls
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(call.init.headers['x-api-key'], 'test-key')
  assert.equal(call.init.headers['anthropic-version'], '2023-06-01')
  // Without this header Anthropic blocks requests whose Origin is an extension.
  assert.equal(call.init.headers['anthropic-dangerous-direct-browser-access'], 'true')

  assert.equal(call.body.tools.length, 1)
  assert.equal(call.body.tools[0].input_schema.type, 'object', 'Claude wants plain JSON Schema')
  assert.deepEqual(call.body.tool_choice, { type: 'tool', name: 'emit_study_notes' })
  assert.equal(call.body.system, PROMPT.system)
  assert.ok(!('response_format' in call.body))
})

test('Claude replying with prose instead of the tool is a retryable failure', async () => {
  stubFetch({ body: { content: [{ type: 'text', text: 'Sure, here are your notes...' }], stop_reason: 'end_turn' } })
  await assert.rejects(
    () => claude.generateStructured(PROMPT, TASK_SCHEMA, config('claude')),
    (e) => e.code === 'AI_INVALID_JSON' && e.retryable === true,
  )
})

// --- error mapping is consistent across providers -------------------------

test('a bad key gives the same actionable error whichever provider it is', async () => {
  const cases = [
    [gemini, 'gemini', { status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }],
    [openai, 'openai', { status: 401, body: { error: { message: 'Incorrect API key provided' } } }],
    [claude, 'claude', { status: 401, body: { error: { message: 'invalid x-api-key' } } }],
  ]

  for (const [adapter, id, reply] of cases) {
    stubFetch(reply)
    await assert.rejects(
      () => adapter.generateStructured(PROMPT, TASK_SCHEMA, config(id)),
      (e) => {
        assert.equal(e.code, 'AI_BAD_KEY', `${id} should report a bad key`)
        assert.match(e.message, new RegExp(PROVIDERS[id].label), `${id} should name itself in the error`)
        return true
      },
    )
  }
})

test('testConnection uses the SAME request construction as real generation', async () => {
  // If Test Connection sent a simpler request than generation does, a pass here
  // would not predict that generation works. So it must carry the structured
  // output mechanism and the system prompt, exactly like a real task.
  const calls = stubFetch(geminiReply({ ok: 'ok', model: 'gemini-3.6-flash' }))
  const result = await gemini.testConnection(config('gemini', { model: 'gemini-3.6-flash' }))

  assert.equal(result.ok, true)
  assert.equal(result.reply, 'ok')

  const [call] = calls
  assert.match(call.url, /models\/gemini-3\.6-flash:generateContent$/)
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json')
  assert.equal(call.body.generationConfig.responseSchema.type, 'OBJECT', 'must exercise responseSchema')
  assert.ok(call.body.systemInstruction, 'must exercise the system prompt')
  // Big enough for a thinking model to finish, small enough to stay cheap.
  // A 256-token probe returns MAX_TOKENS on Gemini 3.x and looks like a failure.
  assert.ok(call.body.generationConfig.maxOutputTokens >= 2048, 'must leave room for thinking tokens')
  assert.ok(call.body.generationConfig.maxOutputTokens <= 4096, 'but stay cheap')
})

test('every adapter tests through its own real structured-output mechanism', async () => {
  let calls = stubFetch(openaiReply({ ok: 'ok', model: 'x' }))
  await openai.testConnection(config('openai'))
  assert.equal(calls[0].body.response_format.type, 'json_schema', 'OpenAI test must use json_schema')

  calls = stubFetch({ body: { content: [{ type: 'tool_use', name: 'emit_study_notes', input: { ok: 'ok', model: 'x' } }], stop_reason: 'tool_use' } })
  await claude.testConnection(config('claude'))
  assert.deepEqual(calls[0].body.tool_choice, { type: 'tool', name: 'emit_study_notes' }, 'Claude test must force the tool')
})

test('a failing testConnection throws rather than reporting success', async () => {
  stubFetch({ status: 401, body: { error: { message: 'Incorrect API key provided' } } })
  await assert.rejects(() => openai.testConnection(config('openai')), (e) => e.code === 'AI_BAD_KEY')
})

test("a 403 leads with the provider's own explanation", async () => {
  // Real xAI response for a valid key on a team with no credits.
  stubFetch({ status: 403, body: { code: 'permission-denied', error: "Your newly created team doesn't have any credits or licenses yet." } })
  await assert.rejects(
    () => openai.testConnection(config('grok')),
    (e) => {
      assert.equal(e.code, 'AI_FORBIDDEN')
      assert.match(e.message, /xAI Grok says: Your newly created team doesn't have any credits/)
      return true
    },
  )
})

test("OpenRouter's upstream reason is surfaced, not its generic wrapper", async () => {
  // Real shape from OpenRouter for a rate-limited free model.
  stubFetch({ status: 429, body: { error: { message: 'Provider returned error', code: 429, metadata: { raw: 'google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly.' } } } })
  await assert.rejects(
    () => openai.testConnection(config('openrouter', { model: 'google/gemma-4-31b-it:free' })),
    (e) => {
      assert.equal(e.code, 'AI_RATE_LIMIT')
      assert.equal(e.retryable, true)
      assert.match(e.detail, /temporarily rate-limited upstream/)
      assert.ok(!/Provider returned error/.test(e.detail))
      return true
    },
  )
})
