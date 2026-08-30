import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskSections, subtopicLetter } from '../src/notion/blocks.js'
import { writeTask } from '../src/notion/pages.js'

/**
 * The Notion hierarchy must mirror the Brototype task:
 *
 *   page
 *   └── 1. Main topic          toggle H1, appended to the PAGE
 *       ├── a. Subtopic        toggle H2, appended INTO the main topic block
 *       ├── b. Subtopic
 *       └── 🧠 Reviewer Questions
 *
 * Never: subtopics as siblings of the main topic on the page.
 */

const topic = (title) => ({ title, whatIsIt: `${title} is…`, simpleExplanation: 'simple', problemSolved: 'p', commonMistakes: ['m'] })
const notes = {
  number: 1, title: 'Understand Advanced React Hooks', summary: 'Hooks for shared state.',
  topics: ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks'].map(topic),
  reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })),
}

test('subtopics are lettered a, b, c… exactly like the Brototype list', () => {
  assert.deepEqual([0, 1, 2, 25, 26, 27].map(subtopicLetter), ['a', 'b', 'c', 'z', 'aa', 'ab'])
  const labels = buildTaskSections(notes).map((s) => s.label)
  assert.deepEqual(labels, ['summary', 'a. useContext', 'b. useReducer', 'c. useMemo', 'd. useCallback', 'e. Custom Hooks', 'Reviewer Questions'])
})

test('every subtopic is a toggle heading with its content nested inside it', () => {
  for (const section of buildTaskSections(notes).slice(1, -1)) {
    const [block] = section.blocks
    assert.equal(block.type, 'heading_2')
    assert.equal(block.heading_2.is_toggleable, true, 'must collapse')
    assert.ok(block.heading_2.children.length >= 3, `${section.label} has no nested content`)
    // section headings inside a subtopic are one level down (H3), never H2
    for (const child of block.heading_2.children) {
      assert.notEqual(child.type, 'heading_2', 'inner section must not compete with the subtopic heading')
      assert.notEqual(child.type, 'heading_1')
    }
  }
})

test('writeTask puts the main topic on the page and EVERYTHING else inside the main topic', async () => {
  const PAGE = 'page-000'
  const TASK = 'task-block-111'
  const requests = []
  let created = 0

  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ url, method: init.method, body })
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => ({
        results: (body?.children || []).map((c, i) => ({ id: created++ === 0 ? TASK : `blk-${created}`, type: c.type })),
      }),
    }
  }

  try {
    const returned = await writeTask('tok', PAGE, notes, {})
    assert.equal(returned, TASK)

    const appends = requests.filter((r) => r.method === 'PATCH' && r.url.includes('/children'))
    assert.ok(appends.length >= 7, 'one append for the main topic, then one per section')

    // 1. exactly ONE thing is appended to the page: the main topic, as a toggle H1
    const toPage = appends.filter((r) => r.url.includes(`/blocks/${PAGE}/children`))
    assert.equal(toPage.length, 1, 'only the main topic goes on the page')
    assert.equal(toPage[0].body.children.length, 1)
    const main = toPage[0].body.children[0]
    assert.equal(main.type, 'heading_1')
    assert.equal(main.heading_1.is_toggleable, true)
    assert.equal(main.heading_1.rich_text[0].text.content, '1. Understand Advanced React Hooks')

    // 2. every other append targets the main topic block - never the page
    const inside = appends.filter((r) => !r.url.includes(`/blocks/${PAGE}/children`))
    assert.equal(inside.length, appends.length - 1)
    for (const r of inside) {
      assert.ok(r.url.includes(`/blocks/${TASK}/children`), `appended outside the main topic: ${r.url}`)
    }

    // 3. and those are the five lettered subtopics (plus summary and questions)
    const subtopicHeadings = inside
      .flatMap((r) => r.body.children)
      .filter((b) => b.type === 'heading_2')
      .map((b) => b.heading_2.rich_text[0].text.content)
    assert.deepEqual(subtopicHeadings, ['a. useContext', 'b. useReducer', 'c. useMemo', 'd. useCallback', 'e. Custom Hooks'])
  } finally {
    delete globalThis.fetch
  }
})
