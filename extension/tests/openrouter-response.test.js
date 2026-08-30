import test from 'node:test'
import assert from 'node:assert/strict'
import { generateStructured } from '../src/ai/openai-compatible.js'

/**
 * How an OpenRouter reply is read.
 *
 * Every one of these used to come back as "OpenRouter returned an empty
 * response. Retrying automatically." — because only `choices[0].message.content`
 * was read. A free-tier rate limit, a missing model, a moderation block and a
 * reasoning model that put its answer in `reasoning` were indistinguishable
 * from a model that genuinely said nothing, so the run retried a request that
 * could never succeed.
 */

const config = {
  id: 'openrouter', label: 'OpenRouter', model: 'nvidia/nemotron-3-super-120b-a12b:free',
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-test', maxOutputTokens: 16384,
  capabilities: { structuredOutput: 'auto', systemPrompt: true },
}
const schema = { type: 'object', properties: { topics: { type: 'array' } }, required: ['topics'] }
const PAYLOAD = '{"topics":[{"title":"useContext"}]}'
const PARSED = { topics: [{ title: 'useContext' }] }

let lastRequest = null
function replyWith(payload, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, headers: init.headers, body: JSON.parse(init.body) }
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) }
  }
}
const run = () => generateStructured({ system: 'sys', user: 'usr' }, schema, config)

test.beforeEach(() => { lastRequest = null })

// --- the request ----------------------------------------------------------

test('the request body is what OpenRouter expects', async () => {
  replyWith({ choices: [{ message: { content: PAYLOAD }, finish_reason: 'stop' }] })
  await run()

  assert.equal(lastRequest.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(lastRequest.body.model, 'nvidia/nemotron-3-super-120b-a12b:free')
  assert.equal(lastRequest.body.messages[0].role, 'system')
  assert.equal(lastRequest.body.messages[1].role, 'user')
  assert.equal(lastRequest.body.max_tokens, 16384)
  assert.equal(lastRequest.headers.Authorization, 'Bearer sk-or-v1-test')
})

test('the key is sent only as a header, never in the body', async () => {
  replyWith({ choices: [{ message: { content: PAYLOAD }, finish_reason: 'stop' }] })
  await run()
  assert.ok(!JSON.stringify(lastRequest.body).includes('sk-or-v1-test'))
})

// --- a successful response -------------------------------------------------

test('a normal response is parsed', async () => {
  replyWith({ choices: [{ message: { content: PAYLOAD }, finish_reason: 'stop' }] })
  assert.deepEqual(await run(), PARSED)
})

test('content returned as an array of parts is joined, not treated as empty', async () => {
  replyWith({ choices: [{ message: { content: [{ type: 'text', text: PAYLOAD }] }, finish_reason: 'stop' }] })
  assert.deepEqual(await run(), PARSED)
})

test('a reasoning model that leaves content empty is read from `reasoning`', async () => {
  // Reasoning tokens come out of the same budget, so a long structured answer
  // can arrive with content empty and everything under reasoning.
  replyWith({ choices: [{ message: { content: '', reasoning: PAYLOAD }, finish_reason: 'stop' }] })
  assert.deepEqual(await run(), PARSED)
})

test('reasoning_details is read too', async () => {
  replyWith({ choices: [{ message: { content: null, reasoning_details: [{ type: 'reasoning.text', text: PAYLOAD }] }, finish_reason: 'stop' }] })
  assert.deepEqual(await run(), PARSED)
})

// --- errors the service reports with HTTP 200 ------------------------------

const bodyErrorCases = [
  ['free-tier rate limit', { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' } }, 'AI_RATE_LIMIT', true],
  ['model not found', { error: { code: 404, message: 'No endpoints found for that model' } }, 'AI_BAD_MODEL', false],
  ['moderation block', { error: { code: 403, message: 'Request blocked by moderation' } }, 'AI_FORBIDDEN', false],
  ['out of credits', { error: { code: 402, message: 'Insufficient credits' } }, 'AI_QUOTA', false],
  ['provider died mid-stream', { choices: [{ message: { content: '' }, finish_reason: 'error', error: { code: 502, message: 'Provider disconnected mid-stream' } }] }, 'AI_SERVER', true],
]

for (const [label, payload, code, retryable] of bodyErrorCases) {
  test(`a ${label} reported with HTTP 200 is surfaced as itself, not as an empty response`, async () => {
    replyWith(payload)
    await assert.rejects(run, (error) => {
      assert.equal(error.code, code, `${label} became ${error.code}`)
      assert.notEqual(error.code, 'AI_EMPTY')
      assert.equal(Boolean(error.retryable), retryable, `${label} retryable should be ${retryable}`)
      return true
    })
  })
}

test('a non-retryable provider error is not retried forever', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ error: { code: 404, message: 'No endpoints found' } }) }
  }
  await assert.rejects(run, (e) => e.code === 'AI_BAD_MODEL')
  assert.equal(calls, 1, 'a missing model must not be retried')
})

// --- a genuinely empty reply ----------------------------------------------

test('a genuinely empty reply says so in words a student can act on', async () => {
  // OpenRouter documents this for a model warming up from a cold start.
  replyWith({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'AI_EMPTY')
    assert.equal(error.message, 'AI returned an empty response. Try again.')
    assert.ok(error.retryable, 'a cold start is worth retrying')
    assert.ok(error.detail.includes('nvidia/nemotron'), 'which model and finish_reason go in the detail')
    assert.ok(!error.detail.includes('sk-or-v1'), 'never the key')
    return true
  })
})

test('a truncated response is reported as truncated, so the task gets split', async () => {
  replyWith({ choices: [{ message: { content: '{"topics":[' }, finish_reason: 'length' }] })
  await assert.rejects(run, (e) => e.code === 'AI_TRUNCATED')
})

test('no error message or detail ever contains the API key', async () => {
  for (const payload of [
    { error: { code: 429, message: 'Rate limit exceeded' } },
    { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] },
  ]) {
    replyWith(payload)
    try { await run() } catch (error) {
      const text = `${error.message} ${error.detail ?? ''}`
      assert.ok(!text.includes('sk-or-v1-test'), `key leaked: ${text}`)
    }
  }
})

// --- the structure the notes end up in is unaffected ------------------------

test('a 5-subtopic task still produces 5 sections when OpenRouter answers via reasoning', async () => {
  const { generateTaskNotes } = await import('../src/ai/generator.js')
  const { resolveStudyStyle, DEFAULT_STUDY_STYLE_SETTINGS } = await import('../src/ai/studyStyle.js')
  const { buildTaskSections } = await import('../src/notion/blocks.js')

  const task = {
    number: 1, title: 'Understand Modern JavaScript for React',
    subtopics: ['Variables and constants', 'Scope and execution flow', 'Primitive and reference types',
      'Type conversion and coercion', 'Template literals'].map((title) => ({ title, children: [] })),
  }
  const answer = JSON.stringify({
    title: task.title, summary: 'Overview.',
    topics: task.subtopics.map((s) => ({ title: s.title, sections: [{ kind: 'text', heading: 'What is it?', text: `Real notes on ${s.title}.` }] })),
    reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, answer: `A${i + 1}.` })),
  })

  // The whole reply arrives in `reasoning` — the shape that used to read empty.
  replyWith({ choices: [{ message: { content: '', reasoning: answer }, finish_reason: 'stop' }] })

  const provider = {
    generateStructured: (prompt, schema, signal) => generateStructured(prompt, schema, config, signal),
  }
  const { notes } = await generateTaskNotes(task, {
    provider, config: {}, unit: {}, pace: async () => {},
    studyStyle: resolveStudyStyle(DEFAULT_STUDY_STYLE_SETTINGS),
  })

  assert.deepEqual(
    buildTaskSections(notes).map((s) => s.label).filter((l) => l !== 'summary' && l !== 'Reviewer Questions'),
    ['a. Variables and constants', 'b. Scope and execution flow', 'c. Primitive and reference types',
      'd. Type conversion and coercion', 'e. Template literals'])
  assert.equal(notes.reviewQuestions.length, 5)
  assert.equal(notes.title, task.title)
})
