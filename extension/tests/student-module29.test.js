import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromStudentDocument, extractFromStudentDocumentExpanding, isStudentPage } from '../src/content/student.js'
import { extractTasks, extractTasksExpanding, detectSite } from '../src/content/sites.js'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * REGRESSION: the live Student page (Module Task - 29, six topics) was reported
 * as "1 task detected" with the title ". State Management with Redux".
 *
 * That output is the Campus reader's: it saw "1). State Management with Redux"
 * as a "1." task heading and read the rest of the page as its subtopics. The
 * page had been routed to Campus because the Student fingerprint was too
 * strict. Detection is now hostname-first, the fingerprint tolerant, and the
 * "N)." prefix on topic titles is stripped.
 */

const HTML = readFileSync(new URL('../../fixtures/brototype-student-module-29.html', import.meta.url), 'utf8')
const CAMPUS_HTML = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')
const LIVE_URL = 'https://student.brototype.com/tasks/module/details?id=88b807d7-b4ea-41c4-8ca3-3161bea6ee5c'

const page = (url = LIVE_URL) => new JSDOM(HTML, { url }).window.document

const TITLES = ['State Management with Redux', 'Redux Middleware & DevTools', 'Error Handling and Validation', 'OLX-like E-Commerce Platform', 'Zustand', 'Deployment']
const NOISE = ['Task Overview', 'Total Topics', 'Your Response', 'Add Attachments', 'No responses added yet', 'Mark as Completed',
  'Request Task Explanation', 'Report An Issue', '1 attachment added', 'task 2', 'I learned how Redux', 'Module Progress', 'Dashboard', 'Log Out', 'Write a short description']

// --- the bug, reproduced then fixed --------------------------------------------------------

test('the Campus reader really does produce "1 task: . State Management with Redux" from this page (the bug\'s signature)', () => {
  const wrong = extractFromDocument(page())
  assert.equal(wrong.ok, true)
  assert.equal(wrong.tasks.length, 1, 'one task instead of six')
  assert.match(wrong.tasks[0].title, /^\. /, 'a "1)." topic title read as a "1." task heading, leaving ". Title"')
})

test('the live URL is routed to the Student reader by hostname, before any fingerprint', () => {
  assert.equal(detectSite(page(), LIVE_URL), 'student')
  // and the fingerprint alone still recognises it, for a saved page with no URL
  assert.equal(isStudentPage(new JSDOM(HTML).window.document), true)
  assert.equal(detectSite(new JSDOM(HTML).window.document, undefined), 'student')
})

test('6 topics on the page -> 6 normalised tasks, numbered 1..6, titles without the "N)." prefix', () => {
  const r = extractTasks(page(), null, LIVE_URL)
  assert.equal(r.site, 'student')
  assert.equal(r.tasks.length, 6, 'task count equals topic count')
  assert.equal(r.tasks.length, r.unit.totalTopics)
  assert.deepEqual(r.tasks.map((t) => t.number), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(r.tasks.map((t) => t.title), TITLES)
})

test('the one topic that is open on the page (Topic 2) is read, with its A)/B) subtopics and nothing from "Your Response"', () => {
  const r = extractFromStudentDocument(page())
  const topic2 = r.tasks[1]
  assert.equal(topic2.expanded, true)
  assert.deepEqual(topic2.subtopics.map((s) => s.title), ['Using middleware (e.g., Redux Thunk)', 'Connecting the app with Redux DevTools for debugging'])
  assert.ok(!topic2.raw.includes('I learned'), 'the student\'s own response is never task content')
  for (const t of r.tasks.filter((x) => x.number !== 2)) assert.deepEqual(t.subtopics, [])
})

test('nothing on the page other than the six topics becomes a task', () => {
  const r = extractFromStudentDocument(page())
  const text = JSON.stringify(r.tasks)
  for (const noise of NOISE) assert.ok(!text.includes(noise), `leaked: ${noise}`)
  assert.ok(!r.tasks.some((t) => /task overview/i.test(t.title)), '"Task Overview" is not a task')
  assert.ok(!r.tasks.some((t) => /your response|add attachments|total topics/i.test(t.title)))
})

test('a saved Campus selector cannot pull this page back into the Campus reader', () => {
  const r = extractTasks(page(), '.custom-scrollbar', LIVE_URL)
  assert.equal(r.site, 'student')
  assert.equal(r.tasks.length, 6)
  assert.ok(!r.warnings.some((w) => /saved task-list location/.test(w)), 'no Campus warning')
})

// --- the accordion, driven --------------------------------------------------------------------

const DETAILS = {
  1: 'A) Redux store, actions and reducers\nB) Connecting React components with useSelector and useDispatch\nWrite a short description about this task.',
  2: 'A) Using middleware (e.g., Redux Thunk)\nB) Connecting the app with Redux DevTools for debugging\nWrite a short description about this task.',
  3: 'A) Handling API errors gracefully\nB) Form validation with user feedback\nWrite a short description about this task.',
  4: 'A) Product listing and search\nB) Sell flow with image upload\nWrite a short description about this task.',
  5: 'A) Creating a store with Zustand\nB) Comparing Zustand with Redux\nWrite a short description about this task.',
  6: 'A) Building for production\nB) Deploying to Vercel\nWrite a short description about this task.',
}
const EXPECTED = Object.values(DETAILS).map((d) => d.split('\n').slice(0, 2).map((l) => l.replace(/^[AB]\)\s*/, '')))

/** The fixture as a working, exclusive MUI accordion (see student-expand.test.js). */
function accordion({ initiallyOpen = [2], broken = [] } = {}) {
  const dom = new JSDOM(HTML, { url: LIVE_URL })
  const doc = dom.window.document
  const heading = (n) => [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === `Topic ${n}`)
  const rowOf = (n) => heading(n).parentElement.parentElement
  const template = rowOf(2).nextElementSibling.cloneNode(true)
  rowOf(2).nextElementSibling.remove()
  rowOf(2).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')

  const open = new Set(); const clicks = []
  const render = (n) => {
    const body = template.cloneNode(true)
    body.querySelector('h6').textContent = heading(n).nextElementSibling.textContent
    body.querySelector('h6 + p').textContent = DETAILS[n]
    body.setAttribute('style', 'overflow: hidden; opacity: 1; height: 0px;')
    rowOf(n).parentElement.appendChild(body)
    rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: rotate(180deg);')
    let h = 0
    const step = () => { h += 60; if (h < 180) { body.setAttribute('style', `overflow: hidden; opacity: 1; height: ${h}px;`); setTimeout(step, 12) } else body.setAttribute('style', 'overflow: hidden; opacity: 1; height: auto;') }
    setTimeout(step, 12)
  }
  const unrender = (n) => { rowOf(n).nextElementSibling?.remove(); rowOf(n).querySelector('[style*="transform"]').setAttribute('style', 'transform: none;') }
  const set = (n, on) => { if (on) { open.add(n); render(n) } else { open.delete(n); unrender(n) } }
  for (let n = 1; n <= 6; n++) {
    rowOf(n).addEventListener('click', () => {
      clicks.push(n)
      if (broken.includes(n)) return
      setTimeout(() => {
        if (open.has(n)) return set(n, false)
        for (const other of [...open]) set(other, false)   // exclusive: opening one closes the other
        set(n, true)
      }, 8)
    })
  }
  for (const n of initiallyOpen) set(n, true)
  return { doc, open, clicks, ready: () => new Promise((r) => setTimeout(r, 120)) }
}

test('all collapsed: every one of the six topics is opened, read, and the page is left collapsed', async () => {
  const { doc, open, ready } = accordion({ initiallyOpen: [] })
  await ready()
  const r = await extractTasksExpanding(doc, null, LIVE_URL, { timeoutMs: 1500 })
  assert.equal(r.site, 'student')
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.tasks.map((t) => t.title), TITLES)
  assert.deepEqual(r.tasks.map((t) => t.subtopics.map((s) => s.title)), EXPECTED)
  assert.deepEqual(r.warnings, [])
  await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual([...open], [])
})

test('one topic initially expanded (Topic 2, as on the live page): all six read, Topic 2 open again at the end', async () => {
  const { doc, open, clicks, ready } = accordion({ initiallyOpen: [2] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.tasks.map((t) => t.subtopics.map((s) => s.title)), EXPECTED)
  // Opening Topic 1 closes Topic 2 (exclusive accordion), so Topic 2 has to be
  // re-opened when its turn comes - once, and once more to restore it. Never more.
  assert.ok(clicks.filter((n) => n === 2).length <= 2, `topic 2 clicked ${clicks.filter((n) => n === 2).length} times`)
  assert.ok(clicks.every((n) => clicks.filter((m) => m === n).length <= 2), 'no topic is clicked repeatedly')
  await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual([...open], [2])
})

test('exclusive accordion: opening Topic 3 closes Topic 2, and Topic 2\'s extracted data survives', async () => {
  const { doc, ready } = accordion({ initiallyOpen: [] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  // By the time Topic 6 was read, Topics 1-5 had all been closed by the accordion.
  const stillOpen = r.tasks.filter((t) => t.expanded).length
  assert.equal(stillOpen, 6, 'each topic was recorded while it was open')
  assert.deepEqual(r.tasks[1].subtopics.map((s) => s.title), EXPECTED[1], 'Topic 2 kept its data after Topic 3 replaced it on screen')
  assert.deepEqual(r.tasks[0].subtopics.map((s) => s.title), EXPECTED[0])
})

test('a topic that will not open is reported by number; the other five are complete', async () => {
  const { doc, ready } = accordion({ initiallyOpen: [], broken: [4] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 250 })
  assert.equal(r.tasks.length, 6)
  assert.deepEqual(r.tasks[3].subtopics, [])
  assert.equal(r.tasks[3].title, 'OLX-like E-Commerce Platform')
  assert.match(r.warnings[0], /1 topic\(s\) could not be expanded.*: 4\./)
  assert.equal(r.tasks.filter((t) => t.subtopics.length === 2).length, 5)
})

// --- Campus unchanged ---------------------------------------------------------------------------

test('Campus extraction is byte-for-byte what it was', async () => {
  const doc = () => new JSDOM(CAMPUS_HTML, { url: 'https://campus.brototype.com/tasks/1' }).window.document
  const direct = extractFromDocument(doc())
  assert.deepEqual(extractTasks(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.deepEqual(await extractTasksExpanding(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.equal(direct.tasks.length, 13)
  assert.equal(detectSite(doc(), 'https://campus.brototype.com/tasks/1'), 'campus')
  assert.equal(isStudentPage(doc()), false)
})

test('a Student-host page with no topic accordion falls back to the Campus reader instead of reporting nothing', () => {
  const doc = new JSDOM(CAMPUS_HTML, { url: 'https://student.brototype.com/some/other/page' }).window.document
  const r = extractTasks(doc, null, 'https://student.brototype.com/some/other/page')
  assert.equal(r.site, 'campus')
  assert.equal(r.tasks.length, 13)
})
