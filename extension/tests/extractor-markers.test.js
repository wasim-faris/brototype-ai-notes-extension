import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * Brototype numbers its subtopics some weeks and letters them others. The DOM
 * is the same either way — an <h4> heading with a sibling <p> holding every
 * subtopic as newline-separated text — so the marker style must not matter.
 *
 * It used to. `ownText()` collapses those newlines, so a numbered list read as
 * "1. Variables and constants 2. Scope and execution flow 3. …", which parsed
 * as a task heading. The element holding the subtopics was then discarded as if
 * it were the next task, and every task reported "no subtopics detected".
 */

// The real page's shape, from fixtures/brototype-task-page.html.
const TASKS = [
  ['Understand Modern JavaScript for React',
    ['Variables and constants', 'Scope and execution flow', 'Primitive and reference types', 'Type conversion and coercion', 'Template literals']],
  ['Understand React Fundamentals',
    ['JSX syntax', 'Components and props', 'Rendering behaviour', 'Keys and lists']],
  ['Understand State and Events',
    ['useState', 'Event handling', 'Controlled inputs', 'Derived state', 'Lifting state up']],
  ['Understand Component Composition',
    ['Children prop', 'Composition vs inheritance', 'Reusable layouts']],
]

const page = (marker) => `<html><body><div><h4>Learning Topics &amp; Workspace</h4><div>${
  TASKS.map(([title, subs], i) => `
    <div><div>
      <h4 class="sc-gSILEF fXTRBO">${i + 1}. ${title}</h4>
      <p class="sc-lbpDNm gsNWTh">${subs.map((s, j) => `${marker(j)} ${s}`).join('\n')}</p>
    </div>
    <div class="sc-kgohyr">
      <span>Text Response</span>
      <textarea placeholder="Enter your topic answer or repository link here..."></textarea>
      <button>Submit Answer</button>
    </div></div>`).join('')
}</div></div></body></html>`

const extract = (marker) => extractFromDocument(new JSDOM(page(marker)).window.document)

const MARKERS = {
  'numbered "1."': (j) => `${j + 1}.`,
  'lettered "a."': (j) => `${String.fromCharCode(97 + j)}.`,
  'numbered "1)"': (j) => `${j + 1})`,
  'lettered "a)"': (j) => `${String.fromCharCode(97 + j)})`,
  'bulleted "-"': () => '-',
  'bulleted "•"': () => '•',
}

for (const [label, marker] of Object.entries(MARKERS)) {
  test(`subtopics are detected when Brototype writes them ${label}`, () => {
    const result = extractFromDocument(new JSDOM(page(marker)).window.document)

    assert.equal(result.ok, true)
    assert.equal(result.tasks.length, TASKS.length, 'the subtopic list must not be mistaken for a task')
    assert.deepEqual(result.tasks.map((t) => t.title), TASKS.map(([title]) => title))

    for (const [i, [title, subs]] of TASKS.entries()) {
      assert.deepEqual(result.tasks[i].subtopics.map((s) => s.title), subs,
        `task ${i + 1} ("${title}") lost its subtopics`)
    }
    assert.deepEqual(result.warnings, [], 'nothing is missing, so nothing should be warned about')
  })
}

test('the reported page returns exactly the five subtopics of task 1', () => {
  const { tasks } = extract((j) => `${j + 1}.`)
  assert.equal(tasks[0].title, 'Understand Modern JavaScript for React')
  assert.deepEqual(tasks[0].subtopics.map((s) => s.title), [
    'Variables and constants',
    'Scope and execution flow',
    'Primitive and reference types',
    'Type conversion and coercion',
    'Template literals',
  ])
})

test('subtopic order is the page order, never sorted or reshuffled', () => {
  const { tasks } = extract((j) => `${j + 1}.`)
  for (const [i, [, subs]] of TASKS.entries()) {
    assert.deepEqual(tasks[i].subtopics.map((s) => s.title), subs, `task ${i + 1} was reordered`)
  }
})

test('a task title is never repeated as one of its own subtopics', () => {
  const { tasks } = extract((j) => `${j + 1}.`)
  for (const task of tasks) {
    assert.ok(!task.subtopics.some((s) => s.title === task.title),
      `task ${task.number} lists its own title as a subtopic`)
  }
})

test('nothing is invented: every subtopic came off the page', () => {
  const { tasks } = extract((j) => `${j + 1}.`)
  for (const [i, [, subs]] of TASKS.entries()) {
    for (const found of tasks[i].subtopics) {
      assert.ok(subs.includes(found.title), `"${found.title}" is not on the page`)
    }
  }
})

test('the answer widgets are never read as subtopics', () => {
  const { tasks } = extract((j) => `${j + 1}.`)
  const all = JSON.stringify(tasks)
  for (const noise of ['Text Response', 'Submit Answer', 'Enter your topic answer']) {
    assert.ok(!all.includes(noise), `leaked UI text: ${noise}`)
  }
})

test('"no subtopics detected" is warned only when a task really has none', () => {
  const html = `<html><body><div>
    <div><h4>1. A task with subtopics</h4><p>1. First\n2. Second</p></div>
    <div><h4>2. A task with none</h4></div>
  </div></body></html>`
  const result = extractFromDocument(new JSDOM(html).window.document)

  assert.equal(result.tasks[0].subtopics.length, 2)
  assert.equal(result.tasks[1].subtopics.length, 0)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /no subtopics detected: 2\./, 'only the genuinely empty task is named')
})

test('a numbered subtopic list is not picked up as the next task heading', () => {
  // The specific misread: the <p> after the heading parsed as "task 1", so the
  // real headings and the lists competed for the biggest consistent group.
  const { tasks } = extract((j) => `${j + 1}.`)
  assert.equal(tasks.length, 4, `${tasks.length} tasks — a subtopic list became a task`)
  for (const task of tasks) {
    assert.ok(!/^\d+\./.test(task.title), `task title still carries a marker: ${task.title}`)
  }
})

// --- the layouts a Brototype card has actually used -------------------------

const SUBS = ['Variables and constants', 'Scope and execution flow', 'Primitive and reference types',
  'Type conversion and coercion', 'Template literals']
const TITLES = ['Understand Modern JavaScript for React', 'Understand Functions & ES6 Features',
  'Understand Arrays & Data Transformation', 'Understand Objects & JSON']

/**
 * Every card also carries a status row ("Submitted (8/17/2026) · View Details")
 * and an answer widget. Both sit between one task and the next, so gathering
 * subtopics has to know where the task ends.
 */
const cardPage = (inner) => `<html><body><h2>Mod 6 — React</h2><div>${
  TITLES.map((title, i) => `
    <div class="card">
      <h4>${i + 1}. ${title}</h4>
      ${inner}
      <div class="status"><span>Submitted</span><span>(8/17/2026)</span><a>View Details</a></div>
      <div><textarea placeholder="Enter your topic answer"></textarea><button>Submit Answer</button></div>
    </div>`).join('')
}</div></body></html>`

const LAYOUTS = {
  'all subtopics in one <p>, newline-separated': `<p>${SUBS.map((s, i) => `${i + 1}. ${s}`).join('\n')}</p>`,
  'one <p> per subtopic': SUBS.map((s, i) => `<p>${i + 1}. ${s}</p>`).join(''),
  'one <div> per subtopic': SUBS.map((s, i) => `<div>${i + 1}. ${s}</div>`).join(''),
  'an <ol> whose numbers are drawn by CSS': `<ol>${SUBS.map((s) => `<li>${s}</li>`).join('')}</ol>`,
  'a <ul> whose bullets are drawn by CSS': `<ul>${SUBS.map((s) => `<li>${s}</li>`).join('')}</ul>`,
  'an <ol> whose items also carry markers': `<ol>${SUBS.map((s, i) => `<li>${i + 1}. ${s}</li>`).join('')}</ol>`,
}

for (const [label, inner] of Object.entries(LAYOUTS)) {
  test(`five source subtopics stay five when the page puts them in ${label}`, () => {
    const result = extractFromDocument(new JSDOM(cardPage(inner)).window.document)

    assert.equal(result.tasks.length, TITLES.length,
      'a subtopic element must never be promoted to a task')
    assert.deepEqual(result.tasks.map((t) => t.title), TITLES)

    for (const task of result.tasks) {
      assert.deepEqual(task.subtopics.map((s) => s.title), SUBS,
        `task ${task.number} came out with ${task.subtopics.length} subtopics`)
    }
    assert.deepEqual(result.warnings, [])
  })
}

test('the card status row and answer widget never become subtopics', () => {
  for (const inner of Object.values(LAYOUTS)) {
    const { tasks } = extractFromDocument(new JSDOM(cardPage(inner)).window.document)
    const all = JSON.stringify(tasks)
    for (const noise of ['Submitted', '8/17/2026', 'View Details', 'Submit Answer', 'Enter your topic answer']) {
      assert.ok(!all.includes(noise), `leaked card chrome: ${noise}`)
    }
  }
})

test('a list drawn by CSS is five subtopics, not one glued-together line', () => {
  // The exact shape that produced "writing notes for 1 topic(s)": five <li>
  // with no markers in the text, which the parser read as one wrapped sentence.
  const { tasks } = extractFromDocument(
    new JSDOM(cardPage(`<ol>${SUBS.map((s) => `<li>${s}</li>`).join('')}</ol>`)).window.document)

  assert.equal(tasks[0].subtopics.length, 5)
  assert.ok(!tasks[0].subtopics.some((s) => s.title.includes('Scope and execution flow') && s.title.includes('Variables')),
    'the five titles were concatenated into one subtopic')
})

test('a repeated numbering run is not mistaken for the task list', () => {
  // With one element per subtopic, the subtopic elements outnumber the real
  // headings 20 to 4. They repeat 1..5 per card; a task list never repeats.
  const { tasks } = extractFromDocument(
    new JSDOM(cardPage(SUBS.map((s, i) => `<p>${i + 1}. ${s}</p>`).join(''))).window.document)

  assert.equal(tasks.length, 4)
  assert.deepEqual(tasks.map((t) => t.number), [1, 2, 3, 4])
})
