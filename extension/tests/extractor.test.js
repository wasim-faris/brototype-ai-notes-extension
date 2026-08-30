import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromDocument, buildPageTitle } from '../src/content/extractor.js'

const html = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')
const doc = new JSDOM(html).window.document
const result = extractFromDocument(doc)

test('detects every task on the real page', () => {
  assert.equal(result.ok, true)
  assert.equal(result.tasks.length, 13)
  assert.equal(result.tasks[0].title, 'Understand Advanced React Hooks')
  assert.equal(result.tasks[12].title, 'Apply Through Hands-on Tasks')
})

test('ignores the answer widget text', () => {
  const allText = JSON.stringify(result.tasks)
  for (const noise of ['Submit Answer', 'Attach Files', 'Record Audio', 'Text Response']) {
    assert.ok(!allText.includes(noise), `leaked UI text: ${noise}`)
  }
})

test('subtopics come through with correct nesting', () => {
  assert.deepEqual(result.tasks[0].subtopics.map((s) => s.title),
    ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks'])

  const thinkingWithAi = result.tasks[11]
  assert.equal(thinkingWithAi.title, 'Thinking with AI')
  assert.deepEqual(thinkingWithAi.subtopics.map((s) => s.title), ['Use AI For', 'Validate', 'Identify'])
  assert.equal(thinkingWithAi.subtopics[0].children.length, 5)

  assert.equal(result.tasks[12].subtopics.length, 10)
})

test('reads the Sem / Paper / Mod chips and builds a page title', () => {
  assert.equal(result.unit.title, 'React - Advanced Concepts')
  assert.equal(result.unit.sem, 'Sem 1')
  assert.equal(result.unit.paper, 'Paper 2')
  assert.equal(result.unit.module, 'Mod 6')
  assert.equal(result.unit.status, 'Assigned')
  assert.equal(result.pageTitle, 'Mod 6 — React - Advanced Concepts')
})

test('no false warnings on a clean page', () => {
  assert.deepEqual(result.warnings, [])
})

test('survives the styled-components class hashes changing', () => {
  // Simulate a Brototype redeploy: every generated class name is different.
  const rebuilt = html.replace(/class="sc-[^"]*"/g, () => `class="sc-${Math.random().toString(36).slice(2, 8)} ${Math.random().toString(36).slice(2, 8)}"`)
  const after = extractFromDocument(new JSDOM(rebuilt).window.document)
  assert.equal(after.tasks.length, 13)
  assert.equal(after.unit.module, 'Mod 6')
})

test('reports a clear reason when there are no tasks', () => {
  const empty = extractFromDocument(new JSDOM('<body><h1>Dashboard</h1></body>').window.document)
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'no-tasks')
})

test('page title falls back sensibly when chips are missing', () => {
  assert.equal(buildPageTitle({ title: 'Node Streams', week: 'Week 12' }), 'Week 12 — Node Streams')
  assert.equal(buildPageTitle({ title: 'Node Streams' }), 'Node Streams')
})
