import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromStudentDocument, extractFromStudentDocumentExpanding, isStudentPage } from '../src/content/student.js'
import { extractTasks, extractTasksExpanding, detectSite } from '../src/content/sites.js'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * The REAL student.brototype.com page (fixtures/brototype-student-real.html):
 * six topics, Topic 1 expanded with A)-D) lines and a submitted response
 * ("task 1 … Read more"), topics 2-6 collapsed with "1 attachment added".
 *
 * Everything below is the runtime path Rescan takes, minus Chrome:
 *   extractTasksExpanding -> detectSite -> topics -> click -> wait -> read.
 */

const HTML = readFileSync(new URL('../../fixtures/brototype-student-real.html', import.meta.url), 'utf8')
const CAMPUS = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')
const URL_ = 'https://student.brototype.com/tasks/module/details?id=88b807d7-b4ea-41c4-8ca3-3161bea6ee5c'
const page = () => new JSDOM(HTML, { url: URL_ }).window.document

const TITLES = ['State Management with Redux', 'Redux Middleware & DevTools', 'Error Handling and Validation', 'OLX-like E-Commerce Platform', 'Zustand', 'MobX']
const TOPIC1 = [
  'Introduction to Redux and the need for global state management',
  'Understanding the Redux data flow',
  'Configuring and using the Redux store',
  'Working with reducers, actions, and dispatch',
]
const NOISE = ['Your Response', 'task 1', 'Add Attachments', 'attachment added', 'Read more', 'Mark as Completed',
  'Request Task Explanation', 'Report An Issue', 'Write a short description', 'I explored', 'Task Overview', 'Total Topics']

// --- detection ------------------------------------------------------------------------

test('detected as Student by the DOM (h1 "Task Overview" + Topic N) and by the hostname', () => {
  assert.equal(isStudentPage(page()), true)
  assert.equal(detectSite(page(), URL_), 'student')
  assert.equal(detectSite(new JSDOM(HTML).window.document, undefined), 'student')
})

// --- the already-open topic, read as-is ----------------------------------------------------

test('Topic 1 (expanded on the page) is read from its own body: title and the four A)-D) subtopics', () => {
  const r = extractFromStudentDocument(page())
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.tasks.map((t) => t.number), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(r.tasks.map((t) => t.title), TITLES)
  const t1 = r.tasks[0]
  assert.equal(t1.expanded, true)
  assert.deepEqual(t1.subtopics, TOPIC1.map((title) => ({ title, children: [] })))
  assert.equal(t1.diagnostics.rendered, true)
  assert.match(t1.diagnostics.bodyText, /^A\) Introduction/)
})

test('nothing from the response widget or page chrome reaches any task', () => {
  const r = extractFromStudentDocument(page())
  const text = JSON.stringify(r.tasks.map(({ diagnostics, ...t }) => t))
  for (const noise of NOISE) assert.ok(!text.includes(noise), `leaked: ${noise}`)
})

test('the same result with EVERY class attribute removed - no css-* class is relied on', () => {
  const doc = page()
  for (const el of doc.querySelectorAll('[class]')) el.removeAttribute('class')
  const r = extractFromStudentDocument(doc)
  assert.deepEqual(r.tasks.map((t) => t.title), TITLES)
  assert.deepEqual(r.tasks[0].subtopics.map((s) => s.title), TOPIC1)
  assert.equal(r.tasks[0].expanded, true)
})

// --- the accordion, driven on the real markup -------------------------------------------------

const DETAILS = {
  1: 'A) Introduction to Redux and the need for global state management\nB) Understanding the Redux data flow\nC) Configuring and using the Redux store\nD) Working with reducers, actions, and dispatch\nWrite a short description about this task.',
  2: 'A) Using middleware (e.g., Redux Thunk)\nB) Connecting the app with Redux DevTools for debugging\nWrite a short description about this task.',
  3: 'A) Handling API errors gracefully\nB) Form validation with user feedback\nWrite a short description about this task.',
  4: 'A) Product listing and search\nB) Sell flow with image upload\nWrite a short description about this task.',
  5: 'A) Basic setup with the create function.\nB) Understand how Zustand avoids boilerplate.\nC) Store creation, Use the Store in a Component\nD) Read and update the state using hooks.\nWrite a short description about this task.',
  6: 'A) Observables and actions\nB) Comparing MobX with Redux\nWrite a short description about this task.',
}
const EXPECTED = Object.values(DETAILS).map((d) => d.split('\n').filter((l) => /^[A-D]\)/.test(l)).map((l) => l.replace(/^[A-D]\)\s*/, '')))

/**
 * The real page as a working MUI-style exclusive accordion. The click handler
 * is on the HEADER ROW (the element with the chevron), the body is the row's
 * next sibling inside the same card, and opening animates height 0 -> auto.
 */
function accordion({ initiallyOpen = [1], broken = [] } = {}) {
  const doc = page()
  const label = (n) => [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === `Topic ${n}`)
  const rowOf = (n) => label(n).parentElement.parentElement
  const cardOf = (n) => rowOf(n).parentElement
  const template = rowOf(1).nextElementSibling.cloneNode(true)
  rowOf(1).nextElementSibling.remove()
  rowOf(1).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')

  const open = new Set(); const clicks = []; const reads = []
  const render = (n) => {
    const body = template.cloneNode(true)
    body.querySelector('h6').textContent = label(n).nextElementSibling.textContent
    body.querySelector('h6 + p').textContent = DETAILS[n]
    body.setAttribute('style', 'overflow: hidden; opacity: 0; height: 0px;')   // MUI Collapse: starts invisible
    cardOf(n).appendChild(body)
    rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: rotate(180deg);')
    let h = 0
    const step = () => {
      h += 60
      if (h < 240) { body.setAttribute('style', `overflow: hidden; opacity: 1; height: ${h}px;`); setTimeout(step, 10) }
      else body.setAttribute('style', 'overflow: hidden; opacity: 1; height: auto;')
    }
    setTimeout(step, 10)
  }
  const unrender = (n) => { rowOf(n).nextElementSibling?.remove(); rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;') }
  const set = (n, on) => { if (on) { open.add(n); render(n) } else { open.delete(n); unrender(n) } }
  for (let n = 1; n <= 6; n++) {
    rowOf(n).addEventListener('click', () => {
      clicks.push(n)
      if (broken.includes(n)) return
      setTimeout(() => {
        if (open.has(n)) return set(n, false)
        for (const o of [...open]) set(o, false)          // exclusive
        set(n, true)
      }, 8)
    })
  }
  for (const n of initiallyOpen) set(n, true)
  return { doc, open, clicks, reads, ready: () => new Promise((r) => setTimeout(r, 120)) }
}

const subs = (r) => r.tasks.map((t) => t.subtopics.map((s) => s.title))

test('one Rescan: all six topics come back with their subtopics; Topic 1 (already open) was read, not clicked; page left as found', async () => {
  const { doc, open, clicks, ready } = accordion({ initiallyOpen: [1] })
  await ready()
  const r = await extractTasksExpanding(doc, null, URL_, { timeoutMs: 1500 })
  assert.equal(r.site, 'student')
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.tasks.map((t) => t.title), TITLES)
  assert.deepEqual(subs(r), EXPECTED, 'every topic has its A)-D) lines')
  assert.ok(r.tasks.every((t) => t.expanded))
  assert.deepEqual(r.warnings, [], 'no "collapsed" and no Campus "had no subtopics" warning')
  assert.equal(clicks[0], 2, 'the first click is on Topic 2 - Topic 1 was open and is read in place')
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual([...open], [1], 'Topic 1 is open again at the end, as the student left it')
})

test('all collapsed: every topic is opened and read, then everything is closed again', async () => {
  const { doc, open, ready } = accordion({ initiallyOpen: [] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(subs(r), EXPECTED)
  assert.deepEqual(r.warnings, [])
  await new Promise((res) => setTimeout(res, 60))
  assert.deepEqual([...open], [])
})

test('the body is never read while MUI Collapse is still animating (opacity 0 / height Npx)', async () => {
  const { doc, ready } = accordion({ initiallyOpen: [] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  for (const t of r.tasks) {
    assert.ok(t.subtopics.length >= 2, `topic ${t.number} was read before its body had content`)
    assert.ok(!/height:|opacity:/.test(t.raw))
  }
})

test('exclusive accordion: Topic 2 opening closes Topic 1, and Topic 1\'s stored result is unaffected', async () => {
  const { doc, ready } = accordion({ initiallyOpen: [1] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(r.tasks[0].subtopics.map((s) => s.title), TOPIC1)
  assert.deepEqual(r.tasks[1].subtopics.map((s) => s.title), EXPECTED[1])
})

test('a topic that never renders is named in a diagnostic warning; the rest are complete', async () => {
  const { doc, ready } = accordion({ initiallyOpen: [1], broken: [4] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 250 })
  assert.deepEqual(r.tasks[3].subtopics, [])
  assert.equal(r.tasks[3].diagnostics.rendered, false)
  assert.equal(r.tasks[3].diagnostics.bodyTitle, null, 'the step that failed: no body heading appeared for Topic 4')
  assert.match(r.warnings[0], /1 topic\(s\) could not be expanded.*: 4\./)
  assert.equal(r.tasks.filter((t) => t.subtopics.length >= 2).length, 5)
})

// --- Campus ------------------------------------------------------------------------------------------

test('Campus is unchanged: same 13 tasks, same routing, zero clicks', async () => {
  const doc = () => new JSDOM(CAMPUS, { url: 'https://campus.brototype.com/tasks/1' }).window.document
  const direct = extractFromDocument(doc())
  assert.deepEqual(extractTasks(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.deepEqual(await extractTasksExpanding(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.equal(direct.tasks.length, 13)
})
