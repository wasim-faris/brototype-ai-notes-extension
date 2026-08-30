import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromDocument } from '../src/content/extractor.js'
import { buildTaskPrompt } from '../src/ai/prompt.js'
import { normaliseTask, resolveSubtopicTitle } from '../src/ai/schema.js'
import { stripListMarker } from '../src/ai/content.js'
import { buildTaskTree, buildSubtopicToggle, buildMainTopicBlock } from '../src/notion/blocks.js'
import { writeTask } from '../src/notion/pages.js'
import * as openai from '../src/ai/openai-compatible.js'
import { extractJson } from '../src/ai/json.js'
import { PROVIDERS } from '../src/ai/registry.js'

/**
 * Regression: a model (nemotron via OpenRouter) restarted numbering at 1,
 * echoed the course context as the task title, and copied the "a." from the
 * notebook description into every subtopic title. The app must own titles
 * and numbering; the model contributes content only.
 */

const html = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')
const extracted = extractFromDocument(new JSDOM(html).window.document)
const PAGE_TITLE = 'Mod 6 — React - Advanced Concepts'

const section = (heading) => ({ heading, kind: 'text', text: 'x', items: [], code: '', language: '', tableHeaders: [], tableRows: [] })

/** The exact bad habits observed: wrong number, context echoed as title, letters in subtopic titles. */
const misbehavingResponse = (task) => ({
  number: 1,
  title: 'React - Advanced Concepts · Sem 1 · Paper 2 · Mod 6',
  summary: '',
  topics: task.subtopics.map((s, i) => ({ title: `${'abcdefghij'[i]}. ${s.title}`, sections: [section(`What is ${s.title}?`)] })),
  reviewQuestions: [],
})

const parentLabel = (tree) => tree.heading_1.rich_text[0].text.content
const subtopicLabels = (tree) => tree.heading_1.children.filter((b) => b.type === 'heading_2').map((b) => b.heading_2.rich_text[0].text.content)

// --- Bug 1: the parent toggle is always the source task -------------------------------

test('Bug 1: tasks 1, 2 and 3 keep their own number and title whatever the model returns', () => {
  const expected = ['1. Understand Advanced React Hooks', '2. Understand State Management Patterns', '3. Understand Context API']
  for (const [i, task] of extracted.tasks.slice(0, 3).entries()) {
    const tree = buildTaskTree(normaliseTask(misbehavingResponse(task), task))
    assert.equal(parentLabel(tree), expected[i])
  }
})

test('Bug 1: the page title is never used as a task heading, and stays the page title', () => {
  assert.equal(extracted.pageTitle, PAGE_TITLE)
  for (const task of extracted.tasks) {
    const label = parentLabel(buildTaskTree(normaliseTask(misbehavingResponse(task), task)))
    assert.ok(!label.includes('React - Advanced Concepts'), `task ${task.number} heading leaked the course title: ${label}`)
    assert.ok(!label.includes('Sem 1'), label)
    assert.equal(label, `${task.number}. ${task.title}`)
  }
})

test('Bug 1: the AI cannot renumber or rename a task even with a clean, plausible title', () => {
  const task = extracted.tasks[1]
  const notes = normaliseTask({ ...misbehavingResponse(task), number: 7, title: 'State Patterns (advanced)' }, task)
  assert.equal(notes.number, 2)
  assert.equal(notes.title, 'Understand State Management Patterns')
})

// --- Bug 2: subtopic letters are written exactly once -------------------------------------

test('Bug 2: "a. Local state" … "e. …" are written exactly once each', () => {
  const task = extracted.tasks[1]
  const labels = subtopicLabels(buildTaskTree(normaliseTask(misbehavingResponse(task), task)))
  assert.deepEqual(labels, [
    'a. Local state',
    'b. Shared state',
    'c. Global state',
    'd. State lifting',
    'e. Choosing appropriate state management approaches',
  ])
  for (const label of labels) {
    assert.equal((label.match(/\b[a-e]\. /g) || []).length, 1, `letter applied more than once: ${label}`)
  }
})

test('Bug 2: the writer itself cannot produce "a. a. …", whatever title it is handed', () => {
  for (const title of ['a. Local state', 'A. Local state', 'a) Local state', '1. Local state', 'Local state']) {
    assert.equal(buildSubtopicToggle({ title, sections: [section('x')] }, 0).heading_2.rich_text[0].text.content, 'a. Local state', title)
  }
  assert.equal(buildMainTopicBlock({ number: 2, title: '2. Understand State Management Patterns' }).heading_1.rich_text[0].text.content,
    '2. Understand State Management Patterns')
})

test('Bug 2: the source subtopic title wins even when the model paraphrases or reorders', () => {
  const sources = [{ title: 'Local state' }, { title: 'Shared state' }, { title: 'Global state' }]
  assert.equal(resolveSubtopicTitle('b. Shared state', sources, 0), 'Shared state', 'matched by text, not position')
  assert.equal(resolveSubtopicTitle('SHARED STATE', sources, 0), 'Shared state', 'case-insensitive match keeps the source spelling')
  assert.equal(resolveSubtopicTitle('Something else entirely', sources, 2), 'Global state', 'no match → the source at that position')
  assert.equal(resolveSubtopicTitle('c. Custom', [], 0), 'Custom', 'no sources at all → the AI title, marker stripped')
  assert.equal(stripListMarker('iii. Poor architectural decisions'), 'Poor architectural decisions')
  assert.equal(stripListMarker('useContext'), 'useContext', 'a bare title is untouched')
})

test('a task with no subtopics keeps the model\'s own topic names, never repeating the task title', () => {
  // Previously the task title stood in for the missing subtopic, which wrote
  // the same heading twice in Notion:
  //     1. Understand MongoDB
  //       a. Understand MongoDB
  // A subtopic may only carry the parent's name when the source task really
  // has one by that name.
  const task = { number: 4, title: 'Understand MongoDB', subtopics: [] }
  const notes = normaliseTask({
    topics: [
      { title: 'a. MongoDB basics', sections: [section('x')] },
      { title: 'Understand MongoDB', sections: [section('y')] },   // an echo of the parent
    ],
  }, task)

  assert.deepEqual(notes.topics.map((t) => t.title), ['MongoDB basics'], 'the echo is dropped')
  assert.deepEqual(subtopicLabels(buildTaskTree(notes)), ['a. MongoDB basics'])
})

// --- the real write path, end to end -------------------------------------------------------

test('writeTask sends the source task as the parent and once-lettered subtopics as children', async () => {
  const task = extracted.tasks[1]
  const notes = normaliseTask(misbehavingResponse(task), task)
  const requests = []
  let n = 0
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ url, body })
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: (body?.children || []).map(() => ({ id: n++ === 0 ? 'task-block' : `b${n}` })) }) }
  }
  try {
    await writeTask('tok', 'page-1', notes, {})
  } finally {
    delete globalThis.fetch
  }
  const [toPage] = requests.filter((r) => r.url.includes('/blocks/page-1/children'))
  assert.equal(toPage.body.children[0].heading_1.rich_text[0].text.content, '2. Understand State Management Patterns')
  const h2s = requests.filter((r) => r.url.includes('/blocks/task-block/children')).flatMap((r) => r.body.children).filter((b) => b.type === 'heading_2')
  assert.deepEqual(h2s.map((b) => b.heading_2.rich_text[0].text.content).slice(0, 2), ['a. Local state', 'b. Shared state'])
})

// --- Bug 4: an empty response is a retryable failure, never content ---------------------------

test('Bug 4: an empty OpenRouter response is AI_EMPTY (retryable) and never reaches normaliseTask', async () => {
  const task = extracted.tasks[1]
  const config = { id: 'openrouter', label: 'OpenRouter', capabilities: PROVIDERS.openrouter.capabilities, maxOutputTokens: 1024, model: 'm', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', meta: PROVIDERS.openrouter }
  for (const content of ['', '   ', null, undefined]) {
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) })
    try {
      await assert.rejects(
        () => openai.generateStructured(buildTaskPrompt(task, {}), { type: 'object' }, config),
        (e) => e.code === 'AI_EMPTY' && e.retryable === true,
        `content=${JSON.stringify(content)} should be AI_EMPTY`,
      )
    } finally {
      delete globalThis.fetch
    }
  }
  assert.throws(() => extractJson(''), (e) => e.code === 'AI_EMPTY')
  assert.throws(() => normaliseTask({}, task), /no usable topics/, 'an empty object is rejected, not given the page title')
})
