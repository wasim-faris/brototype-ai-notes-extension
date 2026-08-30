import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateTaskNotes } from '../src/ai/generator.js'

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '../src')

const task = {
  number: 1,
  title: 'Understand Advanced React Hooks',
  subtopics: [{ title: 'useContext', children: [] }, { title: 'useReducer', children: [] }],
}

const topic = (title) => ({
  title,
  sections: [{ heading: `What is ${title}?`, kind: 'text', text: `about ${title}`, items: [], code: '', language: '', tableHeaders: [], tableRows: [] }],
})

const fullTaskResponse = {
  number: 1, title: task.title, summary: 'summary',
  topics: task.subtopics.map((s) => topic(s.title)),
  reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })),
}

/** A provider facade that is not any real vendor - which is the whole point. */
const fakeProvider = (impl) => ({
  mode: 'direct',
  resolved: { requestsPerMinute: 0 },
  describe: () => 'Fake provider · fake-model',
  generateStructured: impl,
  testConnection: async () => ({ ok: true }),
})

const options = (provider) => ({
  provider,
  config: {},
  unit: { title: 'React' },
  pace: async () => {},
  onProgress: () => {},
})

test('the generator works with a provider that is no real vendor at all', async () => {
  const provider = fakeProvider(async () => fullTaskResponse)
  const { notes, partial } = await generateTaskNotes(task, options(provider))

  assert.equal(notes.topics.length, 2)
  assert.equal(notes.topics[0].title, 'useContext')
  assert.equal(notes.reviewQuestions.length, 5)
  assert.deepEqual(partial, [])
})

test('a truncated response makes the generator split into one call per subtopic', async () => {
  const seen = []
  const provider = fakeProvider(async (prompt, schema) => {
    seen.push(prompt.user)
    if (seen.length === 1) throw Object.assign(new Error('too long'), { code: 'AI_TRUNCATED' })
    if (prompt.user.includes('review questions')) {
      return { reviewQuestions: [{ question: 'Q', answer: 'A' }] }
    }
    const title = prompt.user.includes('useReducer') ? 'useReducer' : 'useContext'
    return topic(title)
  })

  const { notes } = await generateTaskNotes(task, options(provider))
  assert.deepEqual(notes.topics.map((t) => t.title), ['useContext', 'useReducer'])
  assert.ok(seen.length >= 3, 'one whole-task attempt, then per-subtopic calls')
})

test('a subtopic that cannot be generated fails the task instead of writing a short page', async () => {
  // The page must contain every source subtopic. Writing it without one would
  // shift every later letter onto the wrong subtopic, so the task fails and can
  // be retried rather than producing a page that looks finished.
  const asked = []
  const provider = fakeProvider(async (prompt) => {
    if (prompt.user.includes('study notes for EXACTLY')) {
      throw Object.assign(new Error('too long'), { code: 'AI_TRUNCATED' })
    }
    if (prompt.user.includes('review questions')) return { reviewQuestions: [] }
    asked.push(prompt.user.includes('useReducer') ? 'useReducer' : 'useContext')
    if (prompt.user.includes('useReducer')) throw Object.assign(new Error('nope'), { code: 'AI_BAD_REQUEST' })
    return topic('useContext')
  })

  await assert.rejects(() => generateTaskNotes(task, options(provider)), (error) => {
    assert.equal(error.code, 'AI_INCOMPLETE_TASK')
    assert.ok(error.message.includes('useReducer'), 'the message names what could not be written')
    assert.ok(error.retryable, 'so "Retry failed" can pick it up')
    return true
  })

  // The other subtopics were still attempted — one failure does not abort the
  // loop, it just means the task cannot be completed.
  assert.ok(asked.includes('useContext'), 'the healthy subtopic was still asked for')
  assert.ok(asked.filter((a) => a === 'useReducer').length >= 2, 'the failing one was retried before giving up')
})

test('retryable failures are retried, non-retryable ones are not', async () => {
  let attempts = 0
  const flaky = fakeProvider(async () => {
    attempts++
    if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'AI_SERVER', retryable: true })
    return fullTaskResponse
  })
  const { notes } = await generateTaskNotes(task, { ...options(flaky), attempts: 3 })
  assert.equal(notes.topics.length, 2)
  assert.equal(attempts, 3)

  let hardAttempts = 0
  const hard = fakeProvider(async () => {
    hardAttempts++
    throw Object.assign(new Error('bad key'), { code: 'AI_BAD_KEY' })
  })
  await assert.rejects(() => generateTaskNotes(task, options(hard)), (e) => e.code === 'AI_BAD_KEY')
  assert.equal(hardAttempts, 1, 'a bad key must not be retried')
})

test('the generator source contains no provider names', () => {
  const source = readFileSync(`${SRC}/ai/generator.js`, 'utf8')
  for (const vendor of ['gemini', 'openai', 'claude', 'grok', 'anthropic', 'x.ai']) {
    assert.ok(!new RegExp(vendor, 'i').test(source), `generator.js mentions ${vendor}`)
  }
})

test('the Notion layer contains no provider names', () => {
  for (const file of ['blocks.js', 'pages.js', 'client.js']) {
    const source = readFileSync(`${SRC}/notion/${file}`, 'utf8')
    for (const vendor of ['gemini', 'openai', 'claude', 'grok', 'anthropic']) {
      assert.ok(!new RegExp(vendor, 'i').test(source), `notion/${file} mentions ${vendor}`)
    }
  }
})

// --- security -------------------------------------------------------------

/** Follow relative imports from an entry file to get everything it bundles. */
function importGraph(entry, seen = new Set()) {
  const file = existsSync(entry) ? entry : `${entry}.js`
  if (seen.has(file) || !existsSync(file)) return seen
  seen.add(file)

  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    importGraph(resolvePath(dirname(file), match[1]), seen)
  }
  return seen
}

test('the content script cannot reach any API key', () => {
  const graph = [...importGraph(`${SRC}/content/index.js`)]

  // It must not pull in the AI layer, the Notion client, or the config store.
  for (const file of graph) {
    assert.ok(!file.includes('/ai/'), `content script bundles ${file}`)
    assert.ok(!file.includes('/notion/'), `content script bundles ${file}`)
    assert.ok(!file.includes('lib/storage.js'), `content script bundles ${file}`)
  }

  // And nothing in its graph reads a key by name.
  for (const file of graph) {
    const source = readFileSync(file, 'utf8')
    for (const secret of ['apiKey', 'notionToken', 'x-goog-api-key', 'x-api-key', 'Authorization']) {
      assert.ok(!source.includes(secret), `${file} references ${secret}`)
    }
  }
})

test('the content script writes only the one setting it owns', () => {
  const source = readFileSync(`${SRC}/content/index.js`, 'utf8')
  const writes = [...source.matchAll(/chrome\.storage\.local\.set\(([\s\S]{0,120})/g)].map((m) => m[1])
  for (const write of writes) {
    assert.ok(write.includes('taskListSelector'), `content script writes something unexpected: ${write}`)
  }
})

test('no API key is hardcoded anywhere in the source', () => {
  const files = [...importGraph(`${SRC}/background/worker.js`), ...importGraph(`${SRC}/content/index.js`)]
  const patterns = [/AIza[0-9A-Za-z_-]{20,}/, /sk-[a-zA-Z0-9]{20,}/, /sk-ant-[a-zA-Z0-9-]{20,}/, /xai-[a-zA-Z0-9]{20,}/, /\bntn_[a-zA-Z0-9]{20,}/, /secret_[a-zA-Z0-9]{20,}/]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      assert.ok(!pattern.test(source), `${file} looks like it contains a real key (${pattern})`)
    }
  }
})
