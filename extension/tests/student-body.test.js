import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromStudentDocument, extractFromStudentDocumentExpanding } from '../src/content/student.js'
import { extractTasks, extractTasksExpanding } from '../src/content/sites.js'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * REGRESSION: on the live Student page every topic came back "title only".
 *
 * Two causes are covered here. The "Topic N" label may not be a single text
 * node (the number in its own <span>), and the expanded body may sit one or
 * two wrappers away from the header row rather than being its direct sibling.
 * The reader must find each topic's OWN body structurally, read the A) B) C)
 * lines inside it, stop before "Your Response", and never borrow content from
 * a neighbouring topic.
 */

const CAPTURED = readFileSync(new URL('../../fixtures/brototype-student-page.html', import.meta.url), 'utf8')
const MODULE29 = readFileSync(new URL('../../fixtures/brototype-student-module-29.html', import.meta.url), 'utf8')
const CAMPUS = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')
const URL_ = 'https://student.brototype.com/tasks/module/details?id=1'

const TOPICS = [
  ['1). State Management with Redux', 'A) Redux store, actions and reducers\nB) Connecting React components with useSelector and useDispatch\nWrite a short description about this task.'],
  ['2). Redux Middleware & DevTools', 'A) Using middleware (e.g., Redux Thunk)\nB) Connecting the app with Redux DevTools for debugging\nWrite a short description about this task.'],
  ['3). Error Handling and Validation', 'A) Handling API errors gracefully\nB) Form validation with user feedback\nWrite a short description about this task.'],
  ['4). OLX-like E-Commerce Platform', 'A) Product listing and search\nB) Sell flow with image upload\nWrite a short description about this task.'],
  ['5). Zustand', 'A) Basic setup with the create function.\nB) Understand how Zustand avoids boilerplate.\nC) Store creation, Use the Store in a Component\nD) Read and update the state using hooks.\n\nWrite a short description about this task.'],
  ['6). Deployment', 'A) Building for production\nB) Deploying to Vercel\nWrite a short description about this task.'],
]
const EXPECTED = TOPICS.map(([, d]) => d.split('\n').filter((l) => /^[A-D]\)/.test(l)).map((l) => l.replace(/^[A-D]\)\s*/, '')))

/**
 * A six-topic page in a DELIBERATELY different markup from the captured one:
 *   - "Topic <span>N</span>" label
 *   - the header row wrapped in an extra <div role="button">
 *   - the expanded body wrapped in two extra <div>s and placed after that wrapper
 *   - the description inside its own <div>, not a direct sibling of the title
 *   - a response card with a heading of its own, and an attachments chip
 * Nothing here is a css-* class. `open` lists the expanded topic numbers.
 */
function variantPage(open = [], { url = URL_ } = {}) {
  const card = (n, title, desc) => `
    <section class="topic-card">
      <div role="button" tabindex="0" class="hdr-wrap">
        <div class="hdr-row">
          <div class="ico"><svg viewBox="0 0 24 24"><path d="M12 7v14"/></svg></div>
          <div class="txt"><h6>Topic <span>${n}</span></h6><p>${title}</p></div>
          <div class="chip"><span>1 attachment added</span></div>
          <div class="chev" style="transform: ${open.includes(n) ? 'rotate(180deg)' : 'none'};"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></div>
        </div>
      </div>
      ${open.includes(n) ? `
      <div class="collapse" style="overflow: hidden; opacity: 1; height: auto;">
        <div class="inner"><div class="content">
          <div class="task"><h6>${title}</h6><div class="desc-wrap"><p>${desc}</p></div></div>
          <hr>
          <div class="resp"><div class="resp-title">Your Response</div>
            <div class="resp-card"><h6>task ${n}</h6><p>I learned about ${title.slice(4)} and wrote A) my own summary B) with markers that look like subtopics.</p></div>
            <div class="add"><h6>Add Attachments</h6><p>No responses added yet</p></div>
          </div>
        </div></div>
      </div>` : ''}
    </section>`
  const html = `<!doctype html><html><head><title>Brototype - Student Portal</title></head><body>
    <nav><p>Dashboard</p><p>Tasks</p><p>Log Out</p></nav>
    <main>
      <div class="ov"><h1>Task Overview</h1><p>Total Topics: 6</p></div>
      <div class="tools"><p>Mark as Completed</p><span aria-label="Request Task Explanation"><button type="button"></button></span><span aria-label="Report An Issue"><button type="button"></button></span></div>
      <div class="list">${TOPICS.map(([t, d], i) => card(i + 1, t, d)).join('')}</div>
    </main></body></html>`
  return new JSDOM(html, { url }).window.document
}

const subs = (r) => r.tasks.map((t) => t.subtopics.map((s) => s.title))

// --- the expanded body is found and read, wherever the wrappers are ----------------------

test('captured markup: the expanded topic yields real subtopics (never title-only)', () => {
  const r = extractFromStudentDocument(new JSDOM(MODULE29, { url: URL_ }).window.document)
  assert.equal(r.tasks.length, 6)
  assert.equal(r.tasks[1].expanded, true)
  assert.deepEqual(r.tasks[1].subtopics.map((s) => s.title), EXPECTED[1], 'Topic 2 A/B content')
  assert.ok(!r.warnings.some((w) => /had no subtopics detected/.test(w)), 'that is the Campus warning; it must never appear here')
})

test('variant markup: "Topic <span>N</span>" labels and a body two wrappers down are still read', () => {
  const r = extractFromStudentDocument(variantPage([5]))
  assert.equal(r.site, 'student')
  assert.deepEqual(r.tasks.map((t) => t.number), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(r.tasks.map((t) => t.title), TOPICS.map(([t]) => t.replace(/^\d+\)\.\s*/, '')))
  assert.equal(r.tasks[4].expanded, true)
  assert.deepEqual(r.tasks[4].subtopics, [
    { title: 'Basic setup with the create function.', children: [] },
    { title: 'Understand how Zustand avoids boilerplate.', children: [] },
    { title: 'Store creation, Use the Store in a Component', children: [] },
    { title: 'Read and update the state using hooks.', children: [] },
  ])
  for (const t of r.tasks.filter((x) => x.number !== 5)) assert.deepEqual(t.subtopics, [], `topic ${t.number} is collapsed`)
})

test('Topic 2 from the screenshot: A) and B) become subtopics', () => {
  const r = extractFromStudentDocument(variantPage([2]))
  assert.deepEqual(r.tasks[1].subtopics.map((s) => s.title), ['Using middleware (e.g., Redux Thunk)', 'Connecting the app with Redux DevTools for debugging'])
})

test('"Your Response" and everything after it is never task content, even when it contains A)/B) markers', () => {
  const r = extractFromStudentDocument(variantPage([5]))
  const raw = r.tasks[4].raw
  assert.ok(!/Your Response|Add Attachments|No responses|I learned|my own summary|task 5|attachment added|Write a short description/i.test(raw), raw)
  assert.equal(r.tasks[4].subtopics.length, 4, 'exactly the four A-D lines')
})

test('content from one topic never leaks into another (two topics open, non-exclusive page)', () => {
  const r = extractFromStudentDocument(variantPage([2, 5]))
  assert.deepEqual(r.tasks[1].subtopics.map((s) => s.title), EXPECTED[1])
  assert.deepEqual(r.tasks[4].subtopics.map((s) => s.title), EXPECTED[4])
  assert.deepEqual(r.tasks[2].subtopics, [], 'Topic 3 sits between two open topics and gets nothing')
  assert.ok(!r.tasks[1].raw.includes('Zustand') && !r.tasks[4].raw.includes('Redux'))
})

test('the per-topic diagnostics name the elements used, so a layout change is visible in the log', () => {
  const r = extractFromStudentDocument(variantPage([5]))
  const d = r.tasks[4].diagnostics
  assert.equal(d.label, 'h6')
  assert.equal(d.card, 'section')
  assert.equal(d.bodyTitle, 'h6')
  assert.equal(d.rendered, true)
  assert.match(d.bodyText, /^A\) Basic setup/)
  assert.equal(r.tasks[0].diagnostics.rendered, false)
})

// --- the accordion, in the variant markup ------------------------------------------------------

function variantAccordion({ initiallyOpen = [], exclusive = true } = {}) {
  const doc = variantPage(initiallyOpen)
  const label = (n) => [...doc.querySelectorAll('h6')].find((h) => h.textContent.replace(/\s+/g, ' ').trim() === `Topic ${n}`)
  const section = (n) => label(n).closest('section')
  const open = new Set(initiallyOpen); const clicks = []
  const render = (n) => {
    const [title, desc] = TOPICS[n - 1]
    const div = doc.createElement('div')
    div.innerHTML = variantPage([n]).querySelector('.collapse').outerHTML
    const body = div.firstElementChild
    body.setAttribute('style', 'overflow: hidden; opacity: 1; height: 0px;')
    section(n).appendChild(body)
    section(n).querySelector('.chev').setAttribute('style', 'transform: rotate(180deg);')
    let h = 0
    const step = () => { h += 50; if (h < 150) { body.setAttribute('style', `overflow: hidden; opacity: 1; height: ${h}px;`); setTimeout(step, 10) } else body.setAttribute('style', 'overflow: hidden; opacity: 1; height: auto;') }
    setTimeout(step, 10)
    void title; void desc
  }
  const unrender = (n) => { section(n).querySelector('.collapse')?.remove(); section(n).querySelector('.chev').setAttribute('style', 'transform: none;') }
  const set = (n, on) => { if (on) { open.add(n); render(n) } else { open.delete(n); unrender(n) } }
  for (let n = 1; n <= 6; n++) {
    // The page listens on the header WRAPPER, not on the label: the click must bubble.
    section(n).querySelector('.hdr-wrap').addEventListener('click', () => {
      clicks.push(n)
      setTimeout(() => {
        if (open.has(n)) return set(n, false)
        if (exclusive) for (const o of [...open]) set(o, false)
        set(n, true)
      }, 8)
    })
  }
  return { doc, open, clicks, ready: () => new Promise((r) => setTimeout(r, 100)) }
}

test('all collapsed -> every topic expanded and read, including Topic 5\'s four lines; page restored', async () => {
  const { doc, open, ready } = variantAccordion()
  await ready()
  const r = await extractTasksExpanding(doc, null, URL_, { timeoutMs: 1500 })
  assert.equal(r.site, 'student')
  assert.deepEqual(subs(r), EXPECTED)
  assert.ok(r.tasks.every((t) => t.expanded))
  assert.deepEqual(r.warnings, [])
  await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual([...open], [])
})

test('one topic already expanded -> read in place, no click on it before it is read; all six complete', async () => {
  const { doc, clicks, open, ready } = variantAccordion({ initiallyOpen: [1] })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(subs(r), EXPECTED)
  assert.equal(clicks[0], 2, 'the first click is on the first collapsed topic, not on the open one')
  await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual([...open], [1], 'left as found')
})

test('exclusive accordion: each topic is stored while open, so closing it later loses nothing', async () => {
  const { doc, ready } = variantAccordion({ exclusive: true })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 1500 })
  assert.deepEqual(subs(r), EXPECTED)
  assert.equal(r.tasks.filter((t) => t.subtopics.length).length, 6)
})

test('all topics already expanded on a non-exclusive page -> read with zero clicks', async () => {
  const { doc, clicks, ready } = variantAccordion({ initiallyOpen: [1, 2, 3, 4, 5, 6], exclusive: false })
  await ready()
  const r = await extractFromStudentDocumentExpanding(doc, { timeoutMs: 800 })
  assert.deepEqual(subs(r), EXPECTED)
  assert.deepEqual(clicks, [])
})

// --- the originally captured page still reads the same --------------------------------------------

test('the first captured Student page is unchanged: Topic 1 read, 2-5 collapsed', () => {
  const r = extractFromStudentDocument(new JSDOM(CAPTURED).window.document)
  assert.deepEqual(r.tasks.map((t) => t.title), ['Learn Open CV', 'Image Preprocessing', 'Data Augmentation', 'Learn advanced topics', 'Assignment'])
  assert.deepEqual(r.tasks[0].subtopics.map((s) => s.title), ['Reading and displaying images'])
  assert.ok(r.tasks.slice(1).every((t) => !t.expanded && !t.subtopics.length))
})

// --- Campus untouched ----------------------------------------------------------------------------------

test('Campus is byte-for-byte unchanged and never routed through the Student reader', async () => {
  const doc = () => new JSDOM(CAMPUS, { url: 'https://campus.brototype.com/tasks/1' }).window.document
  const direct = extractFromDocument(doc())
  assert.deepEqual(extractTasks(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.deepEqual(await extractTasksExpanding(doc(), null, 'https://campus.brototype.com/tasks/1'), { site: 'campus', ...direct })
  assert.equal(direct.tasks.length, 13)
  assert.deepEqual(direct.tasks[0].subtopics.map((s) => s.title), ['useContext', 'useReducer', 'useMemo', 'useCallback', 'Custom Hooks'])
})
