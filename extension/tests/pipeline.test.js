import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromDocument } from '../src/content/extractor.js'
import { normaliseTask, TASK_SCHEMA } from '../src/ai/schema.js'
import { buildTaskSections, buildPageHeader } from '../src/notion/blocks.js'
import { buildTaskPrompt } from '../src/ai/prompt.js'

const doc = new JSDOM(readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')).window.document
const extracted = extractFromDocument(doc)

/** A plausible AI response for a task: a few sections per subtopic, long-ish text. */
const fakeResponse = (task) => ({
  number: task.number,
  title: task.title,
  summary: 'This task covers the core ideas. '.repeat(4),
  topics: task.subtopics.map((s) => ({
    title: s.title,
    sections: [
      { heading: `What is ${s.title}?`, kind: 'text', text: `Prose about ${s.title}. `.repeat(60), items: [], code: '', language: '', tableHeaders: [], tableRows: [] },
      { heading: 'Important things', kind: 'list', text: '', items: Array.from({ length: 5 }, (_, i) => `Point ${i + 1} about ${s.title}. `.repeat(6)), code: '', language: '', tableHeaders: [], tableRows: [] },
      { heading: 'Simple example', kind: 'code', text: '', items: [], code: `const x = use${s.title.replace(/\W/g, '')}()`, language: 'jsx', tableHeaders: [], tableRows: [] },
      { heading: 'Compared', kind: 'table', text: '', items: [], code: '', language: '', tableHeaders: ['A', 'B'], tableRows: [['1', '2'], ['3', '4']] },
    ],
  })),
  reviewQuestions: Array.from({ length: 5 }, (_, i) => ({
    question: `Question ${i + 1} about ${task.title}?`,
    answer: 'A full answer you could say in a review. '.repeat(40),
  })),
})

/** Walk every block that will be sent to Notion. */
function* walkBlocks(blocks, depth = 0) {
  for (const block of blocks) {
    yield { block, depth }
    const children = block[block.type]?.children || []
    yield* walkBlocks(children, depth + 1)
  }
}

test('the real 13-task page survives the whole pipeline', () => {
  assert.equal(extracted.tasks.length, 13)

  let blockCount = 0
  for (const task of extracted.tasks) {
    const notes = normaliseTask(fakeResponse(task), task)
    assert.equal(notes.topics.length, task.subtopics.length || 1)
    for (const t of notes.topics) assert.equal(t.sections.length, 4)
    assert.equal(notes.reviewQuestions.length, 5)

    for (const section of buildTaskSections(notes)) {
      for (const { block, depth } of walkBlocks(section.blocks)) {
        blockCount++
        assert.ok(depth <= 2, `nesting depth ${depth} exceeds Notion's 2-per-request limit`)

        const value = block[block.type]
        for (const item of value?.rich_text || []) {
          assert.ok(item.text.content.length <= 2000, `rich text of ${item.text.content.length} chars`)
        }
        assert.ok((value?.rich_text || []).length <= 100, 'rich_text array over 100 items')
        assert.ok((value?.children || []).length <= 100, 'children array over 100 items')
      }
    }
  }
  assert.ok(blockCount > 500, `expected a substantial page, got ${blockCount} blocks`)
})

test('page header is valid and mentions the module', () => {
  const header = buildPageHeader(extracted.unit, { taskCount: 13 })
  assert.equal(header.at(-1).type, 'divider')
  const text = header[0].callout.rich_text.map((r) => r.text.content).join('')
  assert.match(text, /Sem 1 · Paper 2 · Mod 6/)
  assert.match(text, /13 tasks/)
})

test('a partly-broken AI response still yields usable notes', () => {
  const task = extracted.tasks[0]
  const broken = fakeResponse(task)
  broken.topics[1] = null                                  // one topic came back as junk
  broken.topics[2] = { title: 'useMemo', sections: [] }    // another came back empty
  broken.reviewQuestions = broken.reviewQuestions.slice(0, 2)

  const notes = normaliseTask(broken, task)
  assert.equal(notes.topics.length, 3, 'keeps the three usable topics')
  assert.equal(notes.reviewQuestions.length, 2, 'keeps whatever questions arrived')
})

test('a completely unusable response is rejected loudly, not written to Notion', () => {
  assert.throws(() => normaliseTask({ topics: [] }, extracted.tasks[0]), /no usable topics/)
  assert.throws(() => normaliseTask('sorry, I cannot help with that', extracted.tasks[0]), /not an object/)
})

test('the prompt lists every subtopic, including nested ones', () => {
  const thinkingWithAi = extracted.tasks[11]
  const { user } = buildTaskPrompt(thinkingWithAi, { unit: extracted.unit })

  assert.match(user, /EXACTLY these 3 subtopics/)
  assert.match(user, /- Use AI For/)
  assert.match(user, /- Architecture reviews/)   // the nested roman numerals survive
  assert.match(user, /Sem 1/)
})

test('a task with no subtopics still produces a prompt for one topic', () => {
  const { user } = buildTaskPrompt({ number: 4, title: 'Understand MongoDB', subtopics: [] }, {})
  assert.match(user, /EXACTLY these 1 subtopics/)
  assert.match(user, /treat the task title itself as the single topic/)
})

test('the schema forces exactly five reviewer questions', () => {
  assert.equal(TASK_SCHEMA.properties.reviewQuestions.minItems, 5)
  assert.equal(TASK_SCHEMA.properties.reviewQuestions.maxItems, 5)
})
