import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

import { extractFromDocument } from '../src/content/extractor.js'
import { buildTaskPrompt } from '../src/ai/prompt.js'
import { generateTaskNotes } from '../src/ai/generator.js'
import { resolveStudyStyle, DEFAULT_STUDY_STYLE_SETTINGS } from '../src/ai/studyStyle.js'
import { buildMainTopicBlock, buildTaskSections } from '../src/notion/blocks.js'

/**
 * The study content is the product. These tests run the REAL path —
 * real page -> real extractor -> real prompt -> real normaliser -> real Notion
 * blocks — and assert that what a student's page says survives to Notion
 * unchanged, and that nothing a model invents can overwrite it.
 *
 * Written after a report of Notion showing "test" where notes should be. The
 * structure below is what makes that impossible for headings; the section
 * bodies are, and must remain, whatever the model actually wrote.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const doc = new JSDOM(readFileSync(`${ROOT}/../fixtures/brototype-task-page.html`, 'utf8')).window.document
const { tasks, unit } = extractFromDocument(doc)
const options = { unit, studyStyle: resolveStudyStyle(DEFAULT_STUDY_STYLE_SETTINGS), pace: async () => {}, config: {} }

const TASK_1_SUBTOPICS = ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks']

/** A provider that writes recognisable real content, the way a working AI does. */
const realProvider = (marker = 'GENERATED-BY-PROVIDER') => ({
  generateStructured: async () => ({
    number: 1, title: 'whatever the model felt like', summary: `${marker} summary`,
    topics: TASK_1_SUBTOPICS.map((t) => ({
      title: t,
      sections: [{ kind: 'what', heading: 'What is it?', body: `${marker}: ${t} explained.` }],
    })),
    reviewQuestions: [{ question: `${marker} question?`, answer: `${marker} answer.` }],
  }),
})

/** The worst plausible model: answers "test" to every single field. */
const testAnsweringProvider = {
  generateStructured: async () => ({
    number: 99, title: 'test', summary: 'test',
    topics: Array.from({ length: 5 }, () => ({
      title: 'test', sections: [{ kind: 'what', heading: 'test', body: 'test' }],
    })),
    reviewQuestions: [{ question: 'test', answer: 'test' }],
  }),
}

const labels = (notes) => buildTaskSections(notes).map((s) => s.label)
const heading = (notes) => {
  const block = buildMainTopicBlock(notes)
  return block[block.type].rich_text[0].text.content
}

// --- the page is read correctly -------------------------------------------

test('task 1 carries exactly its five real subtopics off the page', () => {
  assert.equal(tasks[0].title, 'Understand Advanced React Hooks')
  assert.deepEqual(tasks[0].subtopics.map((s) => s.title), TASK_1_SUBTOPICS)
})

test('every task on the page keeps its own title and its own subtopics', () => {
  assert.equal(tasks.length, 13)
  const titles = tasks.map((t) => t.title)
  assert.equal(new Set(titles).size, titles.length, 'no task may take another task\'s title')
  for (const task of tasks) {
    assert.ok(task.title.trim().length > 3, `task ${task.number} has no real title`)
    assert.ok(!/^test$/i.test(task.title), `task ${task.number} is literally "test"`)
    for (const sub of task.subtopics || []) {
      assert.ok(!/^test$/i.test(sub.title), `task ${task.number} has a subtopic literally "test"`)
    }
  }
})

// --- the AI is asked the right question ------------------------------------

test('the prompt sent to the AI names the task and every one of its subtopics', () => {
  const prompt = buildTaskPrompt(tasks[0], options)
  assert.ok(prompt.user.includes('Understand Advanced React Hooks'))
  for (const subtopic of TASK_1_SUBTOPICS) {
    assert.ok(prompt.user.includes(subtopic), `the AI is never told about "${subtopic}"`)
  }
})

test('the connection-probe prompt is not reachable from the generation path', () => {
  // PROBE_PROMPT/PROBE_SCHEMA exist for "Test connection". If generator.js ever
  // imported them, a probe answer could be written into somebody's notes.
  const generator = readFileSync(`${ROOT}/src/ai/generator.js`, 'utf8')
  assert.ok(!/PROBE_SCHEMA|PROBE_PROMPT/.test(generator),
    'generator.js must not import the connection-probe prompt or schema')
})

// --- what actually reaches Notion ------------------------------------------

test('real provider content is what lands in Notion', async () => {
  const { notes, partial } = await generateTaskNotes(tasks[0], { ...options, provider: realProvider() })
  assert.equal(partial.length, 0)

  const blocks = JSON.stringify([buildMainTopicBlock(notes), buildTaskSections(notes)])
  assert.ok(blocks.includes('GENERATED-BY-PROVIDER'), 'the provider\'s own words must reach Notion')
  assert.ok(blocks.includes('useContext explained'))
  assert.equal(notes.reviewQuestions.length, 1, 'reviewer questions survive')
})

test('a model answering "test" cannot rename the task or any subtopic', async () => {
  // The reported symptom. Headings come from the Brototype page, never the
  // model, so the worst a broken model can do is write poor prose.
  const { notes } = await generateTaskNotes(tasks[0], { ...options, provider: testAnsweringProvider })

  assert.equal(heading(notes), '1. Understand Advanced React Hooks',
    'the task heading is the page\'s, not the model\'s')
  assert.equal(notes.number, 1, 'the model claimed 99 and was ignored')
  assert.deepEqual(notes.topics.map((t) => t.title), TASK_1_SUBTOPICS,
    'all five subtopic titles come from the page, not the model')
  // Only the subtopic sections are asserted here: whether a summary survives a
  // model that answers "test" to everything is incidental, but the lettered
  // sections and their source names are not.
  assert.deepEqual(labels(notes).filter((l) => l !== 'summary' && l !== 'Reviewer Questions'),
    ['a. useContext', 'b. useReducer', 'c. useMemo', 'd. useCallback', 'e. Custom Hooks'])
})

test('the same protection holds for every task, not just the first', async () => {
  for (const task of tasks.slice(0, 6)) {
    const { notes } = await generateTaskNotes(task, { ...options, provider: testAnsweringProvider })
    assert.equal(heading(notes), `${task.number}. ${task.title}`, `task ${task.number} heading was overwritten`)

    // The model returns five topics regardless; each keeps this task's own names.
    const expected = task.subtopics.slice(0, notes.topics.length).map((s) => s.title)
    assert.deepEqual(notes.topics.map((t) => t.title).slice(0, expected.length), expected,
      `task ${task.number} subtopics were overwritten by the model`)
  }
})

// --- mock data cannot be shipped -------------------------------------------

test('no test fixture or mock reaches the built extension', { skip: !existsSync(`${ROOT}/dist/manifest.json`) && 'run npm run build first' }, () => {
  const files = readdirSync(`${ROOT}/dist`).filter((f) => f.endsWith('.js'))
    .concat(readdirSync(`${ROOT}/dist/chunks`).map((f) => `chunks/${f}`))
    .filter((f) => !f.endsWith('.map'))

  for (const file of files) {
    const source = readFileSync(`${ROOT}/dist/${file}`, 'utf8')
    assert.ok(!source.includes('brototype-task-page'), `${file} bundles the HTML test fixture`)
    assert.ok(!source.includes('GENERATED-BY-PROVIDER'), `${file} bundles test content`)
    // node:test / assert only exist in tests; in a bundle they mean a test file
    // was pulled into the extension.
    assert.ok(!/from ?["']node:test["']|require\(["']node:test["']\)/.test(source), `${file} bundles a test module`)
  }
})

test('production source contains no hardcoded study content', () => {
  // A placeholder note body committed "just for now" would silently replace a
  // student's notes. There is no legitimate reason for one to exist.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])

  for (const file of walk(`${ROOT}/src`).filter((f) => /\.jsx?$/.test(f))) {
    const source = readFileSync(file, 'utf8')
    const name = file.slice(ROOT.length + 1)
    // A string that is exactly "test" (or 'test') assigned or returned.
    assert.ok(!/[:=]\s*['"]test['"]/.test(source), `${name} assigns the literal string "test"`)
    assert.ok(!/return\s+['"]test['"]/.test(source), `${name} returns the literal string "test"`)
  }
})
