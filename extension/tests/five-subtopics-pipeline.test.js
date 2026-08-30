import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractFromDocument } from '../src/content/extractor.js'
import { createJob } from '../src/background/job.js'
import { generateTaskNotes } from '../src/ai/generator.js'
import { buildTaskPrompt } from '../src/ai/prompt.js'
import { resolveStudyStyle, DEFAULT_STUDY_STYLE_SETTINGS } from '../src/ai/studyStyle.js'
import { buildTaskSections } from '../src/notion/blocks.js'

/**
 * One real task, followed from the page to the Notion blocks.
 *
 * The reported failure was "1 topics" in the Generate panel and "writing notes
 * for 1 topic(s)" in the log — five source subtopics arriving as one, long
 * before any AI call. Each hop is asserted separately here so a future
 * regression names the hop that broke.
 */

const TITLE = 'Understand Modern JavaScript for React'
const SUBS = [
  'Variables and constants',
  'Scope and execution flow',
  'Primitive and reference types',
  'Type conversion and coercion',
  'Template literals',
]

/** Every layout Brototype could render that list with. */
const LAYOUTS = {
  'one <p>, newline-separated, markers in text': `<p>${SUBS.map((s, i) => `${i + 1}. ${s}`).join('\n')}</p>`,
  'one <p> per subtopic': SUBS.map((s, i) => `<p>${i + 1}. ${s}</p>`).join(''),
  'one <div> per subtopic': SUBS.map((s, i) => `<div>${i + 1}. ${s}</div>`).join(''),
  'an <ol> numbered by CSS': `<ol>${SUBS.map((s) => `<li>${s}</li>`).join('')}</ol>`,
  'a <ul> bulleted by CSS': `<ul>${SUBS.map((s) => `<li>${s}</li>`).join('')}</ul>`,
  'the marker in its own <span>': SUBS.map((s, i) => `<div><span>${i + 1}.</span><span>${s}</span></div>`).join(''),
  'separated by <br>': `<p>${SUBS.map((s, i) => `${i + 1}. ${s}`).join('<br>')}</p>`,
  'no markers in the text at all': `<p>${SUBS.join('\n')}</p>`,
}

/** The card shape from the real page: heading, list, status row, answer box. */
const pageWith = (inner) => `<html><body><h2>Mod 6 — React</h2><div>
  <div class="card">
    <h4>1. ${TITLE}</h4>
    ${inner}
    <div><span>Submitted</span><span>(8/17/2026)</span><a>View Details</a></div>
    <div><textarea placeholder="Enter your topic answer"></textarea><button>Submit Answer</button></div>
  </div>
</div></body></html>`

const extract = (inner) => extractFromDocument(new JSDOM(pageWith(inner)).window.document)

// --- 1. the parser detects five ------------------------------------------

for (const [label, inner] of Object.entries(LAYOUTS)) {
  test(`the parser detects five subtopics when the page uses ${label}`, () => {
    const { tasks } = extract(inner)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].title, TITLE)
    assert.equal(tasks[0].subtopics.length, 5, `got ${tasks[0].subtopics.length}`)
    assert.deepEqual(tasks[0].subtopics.map((s) => s.title), SUBS)
  })
}

test('no subtopic is dropped and none is invented', () => {
  for (const inner of Object.values(LAYOUTS)) {
    const found = extract(inner).tasks[0].subtopics.map((s) => s.title)
    for (const wanted of SUBS) assert.ok(found.includes(wanted), `${wanted} was dropped`)
    for (const got of found) assert.ok(SUBS.includes(got), `${got} was invented`)
    assert.equal(found.length, SUBS.length)
  }
})

test('the card status row and answer widget never become a subtopic', () => {
  for (const inner of Object.values(LAYOUTS)) {
    const all = JSON.stringify(extract(inner).tasks[0].subtopics)
    for (const noise of ['Submitted', '8/17/2026', 'View Details', 'Submit Answer']) {
      assert.ok(!all.includes(noise), `leaked: ${noise}`)
    }
  }
})

// --- 2. the state the Generate panel renders ------------------------------

test('the count the Generate panel shows is the source count', () => {
  for (const inner of Object.values(LAYOUTS)) {
    const task = extract(inner).tasks[0]
    // GenerateView renders `${task.subtopics.length} topics` from exactly this.
    assert.equal(task.subtopics.length, 5, 'the panel would show the wrong number')
  }
})

test('the job the worker stores keeps the same count', () => {
  const tasks = extract(LAYOUTS['one <p> per subtopic']).tasks
  const job = createJob({ pageTitle: 'Mod 6', unit: {}, tasks, strategy: 'ask' })
  assert.equal(job.tasks[0].subtopicCount, 5)
  assert.equal(job.sourceTasks[0].subtopics.length, 5, 'Resume must not lose them either')
})

// --- 3. what generation receives ------------------------------------------

const options = { config: {}, unit: { title: 'Mod 6' }, pace: async () => {}, studyStyle: resolveStudyStyle(DEFAULT_STUDY_STYLE_SETTINGS) }

test('the AI prompt names all five source subtopics', () => {
  const task = extract(LAYOUTS['an <ol> numbered by CSS']).tasks[0]
  const prompt = buildTaskPrompt(task, options)
  for (const sub of SUBS) assert.ok(prompt.user.includes(sub), `the AI is never told about ${sub}`)
})

test('the status line reports five, and never the ambiguous "1 topic(s)"', async () => {
  const task = extract(LAYOUTS['one <div> per subtopic']).tasks[0]
  const messages = []
  const provider = { generateStructured: async () => ({
    topics: SUBS.map((s) => ({ title: s, sections: [{ kind: 'text', heading: 'What is it?', text: `Notes on ${s}.` }] })),
    reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, answer: `A${i + 1}.` })),
  }) }
  await generateTaskNotes(task, { ...options, provider, onProgress: (e) => messages.push(e.message) })

  assert.ok(messages.some((m) => m.includes('5 subtopic(s)')), `status said: ${messages[0]}`)
  assert.ok(!messages.some((m) => /for 1 topic\(s\)/.test(m)))
})

// --- 4. what reaches Notion -----------------------------------------------

test('five source subtopics become exactly five Notion sections, in page order', async () => {
  for (const [label, inner] of Object.entries(LAYOUTS)) {
    const task = extract(inner).tasks[0]
    const provider = { generateStructured: async () => ({
      topics: SUBS.map((s) => ({ title: s, sections: [{ kind: 'text', heading: 'What is it?', text: `Notes on ${s}.` }] })),
      reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, answer: `A${i + 1}.` })),
    }) }
    const { notes } = await generateTaskNotes(task, { ...options, provider })

    assert.equal(notes.topics.length, 5, `${label}: ${notes.topics.length} sections`)
    assert.deepEqual(notes.topics.map((t) => t.title), SUBS, `${label}: wrong titles or order`)
    assert.deepEqual(
      buildTaskSections(notes).map((s) => s.label).filter((l) => l !== 'summary' && l !== 'Reviewer Questions'),
      ['a. Variables and constants', 'b. Scope and execution flow', 'c. Primitive and reference types',
        'd. Type conversion and coercion', 'e. Template literals'],
      `${label}: wrong Notion sections`)
    assert.equal(notes.reviewQuestions.length, 5)
  }
})

test('a model that answers with one topic still yields five sections', async () => {
  // The AI never decides how many subtopics exist: the other four are
  // regenerated against the source.
  const task = extract(LAYOUTS['one <p>, newline-separated, markers in text']).tasks[0]
  let regenerated = 0
  const provider = { generateStructured: async (prompt, schema) => {
    if (schema?.properties?.reviewQuestions && !schema.properties.topics) {
      return { reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, answer: `A${i + 1}.` })) }
    }
    if (!schema?.properties?.topics) {
      regenerated++
      const name = (/ONE subtopic: (.+)$/m.exec(prompt.user) || [])[1]
      return { title: name, sections: [{ kind: 'text', heading: 'What is it?', text: `Notes on ${name}.` }] }
    }
    return {
      topics: [{ title: SUBS[0], sections: [{ kind: 'text', heading: 'What is it?', text: 'Notes.' }] }],
      reviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, answer: `A${i + 1}.` })),
    }
  } }
  const { notes } = await generateTaskNotes(task, { ...options, provider })

  assert.equal(regenerated, 4, 'the four the model skipped were asked for individually')
  assert.deepEqual(notes.topics.map((t) => t.title), SUBS)
})

// --- the layout the real page turned out to use -----------------------------

/**
 * Styled-components renders <span>/<div> whose layout comes from CSS, so a
 * <span> with display:block starts a new visual line while its tag says
 * inline. The text then arrives as ONE line —
 *   "…and constants2. Scope and execution flow3. Primitive…"
 * — and the whole list reads as a single subtopic. This is what put "1 topics"
 * in the Generate panel next to a task that plainly showed five.
 */
const GLUED_LAYOUTS = {
  'inline <span> per subtopic': `<p>${SUBS.map((s, i) => `<span>${i + 1}. ${s}</span>`).join('')}</p>`,
  'one <p> with no separators at all': `<p>${SUBS.map((s, i) => `${i + 1}. ${s}`).join('')}</p>`,
  'inline <b> per subtopic': `<div>${SUBS.map((s, i) => `<b>${i + 1}. ${s}</b>`).join('')}</div>`,
}

for (const [label, inner] of Object.entries(GLUED_LAYOUTS)) {
  test(`five subtopics survive ${label}, where the markers arrive glued together`, () => {
    const { tasks } = extract(inner)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].subtopics.length, 5,
      `got ${tasks[0].subtopics.length}: ${JSON.stringify(tasks[0].subtopics.map((s) => s.title))}`)
    assert.deepEqual(tasks[0].subtopics.map((s) => s.title), SUBS)
  })
}

test('glued markers split even when the items are lowercase, like map() and find()', () => {
  // Task 3 on the real page: "1. Array methods 2. map() 3. filter() …" — no
  // capital letter after the marker to key on.
  const items = ['Array methods', 'map()', 'filter()', 'find()', 'reduce()']
  const { tasks } = extract(`<p>${items.map((s, i) => `${i + 1}. ${s}`).join('')}</p>`)
  assert.deepEqual(tasks[0].subtopics.map((s) => s.title), items)
})

test('a number inside a sentence is not treated as a marker', () => {
  // The split only fires when a marker is glued to a non-space character, so
  // ordinary prose keeps its numbers.
  const { tasks } = extract('<p>1. Read chapter 4. Then answer the questions\n2. Review ES 6. Modules</p>')
  assert.deepEqual(tasks[0].subtopics.map((s) => s.title),
    ['Read chapter 4. Then answer the questions', 'Review ES 6. Modules'])
})

// --- the real page, captured from the browser -------------------------------

/**
 * The markup Brototype actually serves (fixtures/brototype-task-page-2026.html).
 *
 * Its subtopics live in one <p>, newline-separated, each line indented by three
 * spaces:
 *
 *     <p>   1. Variables and constants
 *    2. Scope and execution flow
 *    …</p>
 *
 * `elementToText` used to finish with .trim(), which strips that indent from
 * the FIRST line only. Lines 2..n then looked one level deeper and the parser
 * nested them under subtopic 1 — one root with four hidden children, which the
 * Generate panel reported as "1 topics".
 */
test('the real Brototype page yields every subtopic of every task', async () => {
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../../fixtures/brototype-task-page-2026.html', import.meta.url), 'utf8')
  const result = extractFromDocument(new JSDOM(html).window.document)

  assert.equal(result.tasks.length, 4)
  assert.equal(result.pageTitle, 'Mod 4 — Understand Modern JavaScript for React')

  const expected = {
    'Understand Modern JavaScript for React': SUBS,
    'Understand Functions & ES6 Features': ['Function declarations and expressions', 'Arrow functions',
      'Destructuring', 'Spread and rest operators', 'Import and export statements'],
    // Six, not five: the count is the page's, never a fixed number.
    'Understand Arrays & Data Transformation': ['Array methods', 'map()', 'filter()', 'find()',
      'reduce()', 'Rendering lists dynamically'],
    'Understand Asynchronous JavaScript': ['Synchronous vs asynchronous execution', 'Promises',
      'async/await', 'Fetching external data', 'Handling asynchronous workflows'],
  }

  for (const task of result.tasks) {
    assert.deepEqual(task.subtopics.map((s) => s.title), expected[task.title], `task ${task.number}`)
    // Flat, not one root hiding the rest as children.
    for (const sub of task.subtopics) {
      assert.equal(sub.children.length, 0, `"${sub.title}" swallowed ${sub.children.length} siblings`)
    }
  }
  assert.deepEqual(result.warnings, [])
})

test('indented subtopics are siblings, not children of the first one', () => {
  // The exact shape, reduced: every line indented by the same amount.
  const { tasks } = extract(`<p>   1. ${SUBS.join('\n   2. ').replace(/^/, '')}</p>`)
  assert.ok(tasks[0].subtopics.length > 1, 'the indent must not nest them')

  const indented = extract(`<p>${SUBS.map((s, i) => `   ${i + 1}. ${s}`).join('\n')}</p>`)
  assert.deepEqual(indented.tasks[0].subtopics.map((s) => s.title), SUBS)
  assert.equal(indented.tasks[0].subtopics[0].children.length, 0)
})

test('genuine deeper indentation still nests', () => {
  // Dedenting removes only what every line shares, so real nesting survives.
  const { tasks } = extract('<p>   a. Use AI For\n      i. Architecture reviews\n      ii. Debugging\n   b. Validate</p>')
  assert.deepEqual(tasks[0].subtopics.map((s) => s.title), ['Use AI For', 'Validate'])
  assert.deepEqual(tasks[0].subtopics[0].children.map((c) => c.title), ['Architecture reviews', 'Debugging'])
})
