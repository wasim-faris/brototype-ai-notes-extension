import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromStudentDocumentExpanding, extractFromStudentDocument } from '../src/content/student.js'
import { extractTasksExpanding, extractTasks } from '../src/content/sites.js'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * The Student accordion, driven by the extension.
 *
 * JSDOM has no React, so each test installs a small fake accordion on the real
 * fixture: clicking a topic's header row toggles it exactly the way MUI does -
 * asynchronously, through an animated `height: Npx` phase, and (like the real
 * page) closing whichever other topic was open. The reader must cope with all
 * of that and then leave the page as it found it.
 */

const STUDENT_HTML = readFileSync(new URL('../../fixtures/brototype-student-page.html', import.meta.url), 'utf8')
const CAMPUS_HTML = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')

const DETAILS = {
  1: 'Reading and displaying images',
  2: 'Resizing and cropping\n\nColour space conversion\n\nWrite a short description about this task.',
  3: '1. Flips and rotations\n2. Brightness and contrast\n\nWrite a short description about this task.',
  4: 'Object detection basics\n\nWrite a short description about this task.',
  5: 'Build a small classifier\n\nWrite a short description about this task.',
}

/**
 * Turn the fixture into a working accordion.
 *   options.initiallyOpen  which topic numbers start expanded (default: [1], as captured)
 *   options.broken         topic numbers whose click does nothing (content never renders)
 *   options.animate        emulate MUI's height animation before settling
 *   options.exclusive      closing others when one opens (MUI accordion default)
 */
function makeAccordion({ initiallyOpen = [1], broken = [], animate = true, exclusive = true } = {}) {
  const dom = new JSDOM(STUDENT_HTML, { url: 'https://student.brototype.com/tasks/42' })
  const doc = dom.window.document
  const heading = (n) => [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === `Topic ${n}`)
  const rowOf = (n) => heading(n).parentElement.parentElement
  const titleOf = (n) => heading(n).nextElementSibling.textContent.trim()

  // Take the captured body as a template, then remove it: state is rebuilt below.
  const template = rowOf(1).nextElementSibling.cloneNode(true)
  rowOf(1).nextElementSibling.remove()
  rowOf(1).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')

  const clicks = []
  const state = { open: new Set() }

  const render = (n) => {
    const body = template.cloneNode(true)
    body.querySelector('h6').textContent = titleOf(n)
    body.querySelector('h6 + p').textContent = DETAILS[n]
    body.setAttribute('style', animate ? 'overflow: hidden; opacity: 1; height: 0px;' : 'overflow: hidden; opacity: 1; height: auto;')
    rowOf(n).parentElement.appendChild(body)
    rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: rotate(180deg);')
    if (animate) {
      // Three animation frames, then settle - the way MUI's Collapse behaves.
      let h = 0
      const step = () => {
        h += 40
        if (h < 120) { body.setAttribute('style', `overflow: hidden; opacity: 1; height: ${h}px;`); setTimeout(step, 15) }
        else body.setAttribute('style', 'overflow: hidden; opacity: 1; height: auto;')
      }
      setTimeout(step, 15)
    }
  }
  const unrender = (n) => {
    rowOf(n).nextElementSibling?.remove()
    rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')
  }

  const setOpen = (n, open) => { if (open) { state.open.add(n); render(n) } else { state.open.delete(n); unrender(n) } }

  for (let n = 1; n <= 5; n++) {
    rowOf(n).addEventListener('click', () => {
      clicks.push(n)
      if (broken.includes(n)) return
      // React updates on the next tick, not inside the click handler.
      setTimeout(() => {
        if (state.open.has(n)) return setOpen(n, false)
        if (exclusive) for (const other of [...state.open]) setOpen(other, false)
        setOpen(n, true)
      }, 10)
    })
  }
  for (const n of initiallyOpen) setOpen(n, true)
  // Let any initial animation finish before the test starts reading.
  return { doc, clicks, state, ready: () => new Promise((r) => setTimeout(r, animate ? 120 : 0)) }
}

const titles = (r) => r.tasks.map((t) => t.subtopics.map((s) => s.title))

const EXPECTED = [
  ['Reading and displaying images'],
  ['Resizing and cropping', 'Colour space conversion'],
  ['Flips and rotations', 'Brightness and contrast'],
  ['Object detection basics'],
  ['Build a small classifier'],
]

// --- the four starting states ------------------------------------------------------

test('all topics collapsed: every one is opened, read, and closed again', async () => {
  const { doc, clicks, state, ready } = makeAccordion({ initiallyOpen: [] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })

  assert.equal(r.ok, true)
  assert.deepEqual(r.tasks.map((t) => t.number), [1, 2, 3, 4, 5])
  assert.deepEqual(titles(r), EXPECTED)
  assert.ok(r.tasks.every((t) => t.expanded), 'each topic was read while open')
  assert.deepEqual(r.warnings, [], 'nothing to warn about')
  assert.deepEqual(r.expandedByExtension, [1, 2, 3, 4, 5])

  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual([...state.open], [], 'the page is left as it was found: everything collapsed')
  assert.equal(clicks.filter((n) => n === 1).length <= 2, true, 'no repeated clicking of the same topic')
})

test('one topic already expanded (the captured page): it is read without being clicked, and stays open at the end', async () => {
  const { doc, clicks, state, ready } = makeAccordion({ initiallyOpen: [1] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })

  assert.deepEqual(titles(r), EXPECTED)
  assert.ok(!clicks.slice(0, 4).includes(1), 'topic 1 was never clicked while being read')
  assert.deepEqual(r.expandedByExtension, [2, 3, 4, 5])

  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual([...state.open], [1], 'the student\'s own open topic is open again')
})

test('all topics already expanded (non-exclusive page): read in place, zero clicks', async () => {
  const { doc, clicks, ready } = makeAccordion({ initiallyOpen: [1, 2, 3, 4, 5], exclusive: false })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(titles(r), EXPECTED)
  assert.deepEqual(clicks, [])
  assert.deepEqual(r.expandedByExtension, [])
  assert.deepEqual(r.warnings, [])
})

test('accordion animation: a topic is read only once its body has rendered and stopped moving', async () => {
  const { doc, ready } = makeAccordion({ initiallyOpen: [], animate: true })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(titles(r), EXPECTED, 'no topic was read mid-animation with an empty body')
  for (const t of r.tasks) assert.ok(!/height:\s*\d+px/.test(t.raw), 'no style noise in the text')
})

test('a topic whose content never appears is reported, not invented, and the rest are still read', async () => {
  const { doc, ready } = makeAccordion({ initiallyOpen: [], broken: [3] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 300 })

  assert.equal(r.ok, true)
  assert.deepEqual(titles(r), [EXPECTED[0], EXPECTED[1], [], EXPECTED[3], EXPECTED[4]])
  assert.equal(r.tasks[2].title, 'Data Augmentation', 'the title is still known')
  assert.equal(r.tasks[2].expanded, false)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /1 topic\(s\) could not be expanded/)
  assert.match(r.warnings[0], /: 3\./)
})

test('a page that will not expand anything at all degrades to titles plus one clear warning', async () => {
  const { doc, ready } = makeAccordion({ initiallyOpen: [], broken: [1, 2, 3, 4, 5] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 200 })
  assert.deepEqual(r.tasks.map((t) => t.title), ['Learn Open CV', 'Image Preprocessing', 'Data Augmentation', 'Learn advanced topics', 'Assignment'])
  assert.ok(r.tasks.every((t) => t.subtopics.length === 0))
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /5 topic\(s\) could not be expanded.*1, 2, 3, 4, 5/)
})

test('the page is never touched when restore is off and everything is read from what is already open', async () => {
  const { doc, clicks, ready } = makeAccordion({ initiallyOpen: [1, 2, 3, 4, 5], exclusive: false })
  await ready()
  await extractFromStudentDocumentExpanding(doc, { timeoutMs: 500, restore: false })
  assert.deepEqual(clicks, [])
})

// --- the result is what the pipeline expects ----------------------------------------------

test('the expanded result has the same normalised shape as the plain reader and as Campus', async () => {
  const { doc, ready } = makeAccordion({ initiallyOpen: [] })
  await ready()
  const expanded = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  const plain = extractFromStudentDocument(new JSDOM(STUDENT_HTML).window.document)
  const campus = extractFromDocument(new JSDOM(CAMPUS_HTML).window.document)

  const keys = (t) => Object.keys(t).filter((k) => ['number', 'title', 'subtopics', 'raw'].includes(k)).sort()
  assert.deepEqual(keys(expanded.tasks[0]), keys(plain.tasks[0]))
  assert.deepEqual(keys(expanded.tasks[0]), keys(campus.tasks[0]))
  assert.deepEqual(Object.keys(expanded.tasks[1].subtopics[0]).sort(), ['children', 'title'])
  assert.equal(expanded.unit.totalTopics, 5)
  assert.equal(expanded.pageTitle, plain.pageTitle)
})

// --- Campus is untouched by the async path ---------------------------------------------------

test('extractTasksExpanding on a Campus page returns exactly the synchronous Campus result', async () => {
  const doc = () => new JSDOM(CAMPUS_HTML, { url: 'https://campus.brototype.com/tasks/1' }).window.document
  const sync = extractTasks(doc(), null, 'https://campus.brototype.com/tasks/1')
  const viaAsync = await extractTasksExpanding(doc(), null, 'https://campus.brototype.com/tasks/1')
  assert.deepEqual(viaAsync, sync)
  assert.equal(viaAsync.site, 'campus')
  assert.equal(viaAsync.tasks.length, 13)
  assert.deepEqual(viaAsync.tasks[0].subtopics.map((s) => s.title), ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks'])
})

test('a Campus page is never clicked', async () => {
  const dom = new JSDOM(CAMPUS_HTML, { url: 'https://campus.brototype.com/tasks/1' })
  let clicks = 0
  dom.window.document.addEventListener('click', () => clicks++)
  await extractTasksExpanding(dom.window.document, null, 'https://campus.brototype.com/tasks/1')
  assert.equal(clicks, 0)
})
