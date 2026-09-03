import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { extractFromStudentDocument, isStudentPage } from '../src/content/student.js'
import { extractTasks, detectSite, siteFromUrl } from '../src/content/sites.js'
import { extractFromDocument } from '../src/content/extractor.js'

/**
 * student.brototype.com, read from the real page captured in
 * fixtures/brototype-student-page.html. Topic 1 is expanded there; topics
 * 2–5 are collapsed. The tests below also re-arrange that DOM to expand a
 * different topic, so nothing depends on it being Topic 1.
 */

const STUDENT_HTML = readFileSync(new URL('../../fixtures/brototype-student-page.html', import.meta.url), 'utf8')
const CAMPUS_HTML = readFileSync(new URL('../../fixtures/brototype-task-page.html', import.meta.url), 'utf8')

const studentDoc = (url = 'https://student.brototype.com/tasks/42') => new JSDOM(STUDENT_HTML, { url }).window.document
const campusDoc = (url = 'https://campus.brototype.com/tasks/1') => new JSDOM(CAMPUS_HTML, { url }).window.document

const NOISE = ['Task Overview', 'Total Topics', 'Mark as Completed', 'Request Task Explanation', 'Report An Issue',
  'Your Response', 'Add Attachments', 'No responses added yet', 'Write a short description']

// --- 1. detection ------------------------------------------------------------------

test('the Student page is recognised by its DOM, and by its hostname', () => {
  assert.equal(isStudentPage(studentDoc()), true)
  assert.equal(isStudentPage(campusDoc()), false)
  assert.equal(detectSite(studentDoc()), 'student')
  assert.equal(detectSite(campusDoc()), 'campus')
  assert.equal(siteFromUrl('https://student.brototype.com/x'), 'student')
  assert.equal(siteFromUrl('https://app.student.brototype.com/x'), 'student')
  assert.equal(siteFromUrl('https://campus.brototype.com/x'), 'campus')
  assert.equal(siteFromUrl('https://learn.brototype.com/x'), null)
  assert.equal(siteFromUrl('not a url'), null)
  // A fixture with no URL at all is still read as Student: the DOM decides.
  assert.equal(detectSite(new JSDOM(STUDENT_HTML).window.document), 'student')
})

// --- 2–7. extraction ---------------------------------------------------------------

const result = extractFromStudentDocument(studentDoc())

test('every topic is extracted with its number and title, in order', () => {
  assert.equal(result.ok, true)
  assert.equal(result.site, 'student')
  assert.deepEqual(result.tasks.map((t) => t.number), [1, 2, 3, 4, 5])
  assert.deepEqual(result.tasks.map((t) => t.title),
    ['Learn Open CV', 'Image Preprocessing', 'Data Augmentation', 'Learn advanced topics', 'Assignment'])
  assert.equal(result.unit.totalTopics, 5)
  assert.equal(result.unit.site, 'student')
})

test('the expanded topic yields its task title, description and subtopics', () => {
  const [topic1] = result.tasks
  assert.equal(topic1.expanded, true)
  assert.equal(topic1.raw, 'Reading and displaying images')
  assert.deepEqual(topic1.subtopics, [{ title: 'Reading and displaying images', children: [] }])
})

test('collapsed topics keep their title, have no subtopics, and are reported once', () => {
  for (const t of result.tasks.slice(1)) {
    assert.equal(t.expanded, false, `topic ${t.number}`)
    assert.deepEqual(t.subtopics, [])
    assert.equal(t.raw, '')
  }
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /4 topic\(s\) are collapsed/)
  assert.match(result.warnings[0], /2, 3, 4, 5/)
  assert.match(result.warnings[0], /Expand a topic/)
})

test('no page chrome leaks into any task', () => {
  const text = JSON.stringify(result.tasks)
  for (const noise of NOISE) assert.ok(!text.includes(noise), `leaked: ${noise}`)
})

test('the normalised shape is the one Campus produces, so the rest of the app cannot tell them apart', () => {
  const campus = extractFromDocument(campusDoc())
  for (const key of ['ok', 'source', 'unit', 'pageTitle', 'tasks', 'warnings']) assert.ok(key in result, key)
  const shape = (task) => Object.keys(task).filter((k) => ['number', 'title', 'subtopics', 'raw'].includes(k)).sort()
  assert.deepEqual(shape(result.tasks[0]), shape(campus.tasks[0]))
  assert.equal(typeof result.tasks[0].number, typeof campus.tasks[0].number)
  assert.deepEqual(Object.keys(result.tasks[0].subtopics[0]).sort(), Object.keys(campus.tasks[0].subtopics[0]).sort())
  for (const key of ['title', 'sem', 'paper', 'module', 'week', 'status', 'type']) assert.ok(key in result.unit, `unit.${key}`)
})

// --- 8/9. expanded state is read, not assumed ---------------------------------------

/** Move the expanded body from topic 1 to topic N and flip the chevrons. */
function expandInstead(doc, n) {
  const heading = (k) => [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === `Topic ${k}`)
  const rowOf = (h) => h.parentElement.parentElement
  const row1 = rowOf(heading(1))
  const rowN = rowOf(heading(n))
  const body = row1.nextElementSibling
  row1.querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')
  rowN.querySelector('[style*="transform"]').setAttribute('style', 'transform: rotate(180deg);')
  rowN.parentElement.appendChild(body)
  body.querySelector('h6').textContent = heading(n).nextElementSibling.textContent.trim()
  body.querySelector('p').textContent = `Resize and normalise images\n\nConvert colour spaces\n\nWrite a short description about this task.`
  return doc
}

test('whichever topic is expanded is the one whose details are read (topic 3 here)', () => {
  const r = extractFromStudentDocument(expandInstead(studentDoc(), 3))
  assert.deepEqual(r.tasks.map((t) => t.expanded), [false, false, true, false, false])
  assert.deepEqual(r.tasks[2].subtopics.map((s) => s.title), ['Resize and normalise images', 'Convert colour spaces'])
  assert.deepEqual(r.tasks[0].subtopics, [], 'topic 1 is now collapsed and contributes only its title')
  assert.equal(r.tasks[2].title, 'Data Augmentation')
  assert.match(r.warnings[0], /1, 2, 4, 5/)
})

test('a body that is present but hidden (collapsing animation) counts as collapsed', () => {
  const doc = studentDoc()
  const body = [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === 'Topic 1').parentElement.parentElement.nextElementSibling
  body.setAttribute('style', 'overflow: hidden; opacity: 0; height: 0px;')
  body.parentElement.querySelector('[style*="transform"]').setAttribute('style', 'transform: none;')
  const r = extractFromStudentDocument(doc)
  assert.equal(r.tasks[0].expanded, false)
  assert.deepEqual(r.tasks[0].subtopics, [])
})

test('every topic collapsed still lists every topic, and says so', () => {
  const doc = studentDoc()
  const body = [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === 'Topic 1').parentElement.parentElement.nextElementSibling
  body.remove()
  doc.querySelector('[style*="rotate"]').setAttribute('style', 'transform: none;')
  const r = extractFromStudentDocument(doc)
  assert.equal(r.tasks.length, 5)
  assert.ok(r.tasks.every((t) => !t.expanded && t.subtopics.length === 0))
  assert.match(r.warnings[0], /5 topic\(s\) are collapsed/)
})

test('a description with numbered lines becomes numbered subtopics, without the boilerplate', () => {
  const doc = studentDoc()
  const body = [...doc.querySelectorAll('h6')].find((h) => h.textContent.trim() === 'Topic 1').parentElement.parentElement.nextElementSibling
  body.querySelector('h6 + p').textContent = '1. Reading images\n2. Displaying images\n3. Saving images\n\nWrite a short description about this task.'
  const r = extractFromStudentDocument(doc)
  assert.deepEqual(r.tasks[0].subtopics.map((s) => s.title), ['Reading images', 'Displaying images', 'Saving images'])
})

// --- 10. the dispatcher leaves Campus exactly as it was --------------------------------

test('extractTasks routes Campus to the original extractor with an identical result', () => {
  const direct = extractFromDocument(campusDoc())
  const routed = extractTasks(campusDoc(), null, 'https://campus.brototype.com/tasks/1')
  assert.deepEqual(routed, { site: 'campus', ...direct })
  assert.equal(routed.tasks.length, 13)
})

test('extractTasks routes Student to the Student adapter', () => {
  const routed = extractTasks(studentDoc(), null, 'https://student.brototype.com/tasks/42')
  assert.equal(routed.site, 'student')
  assert.equal(routed.tasks.length, 5)
})

test('a saved Campus selector is still honoured, and never applied to Student', () => {
  const campus = extractTasks(campusDoc(), 'body', 'https://campus.brototype.com/x')
  assert.equal(campus.ok, true)
  const student = extractTasks(studentDoc(), '.does-not-exist', 'https://student.brototype.com/x')
  assert.equal(student.ok, true)
  assert.equal(student.warnings.some((w) => /saved task-list location/.test(w)), false)
})

// --- manifest ---------------------------------------------------------------------------

test('the manifest already allows both sites and their subdomains, with nothing broader', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  const patterns = manifest.host_permissions.filter((h) => /brototype/.test(h))
  const matches = (url) => patterns.some((p) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(url))
  for (const url of ['https://campus.brototype.com/tasks/1', 'https://app.campus.brototype.com/x', 'https://student.brototype.com/tasks/1', 'https://app.student.brototype.com/x']) {
    assert.ok(matches(url), url)
  }
  assert.ok(!matches('https://evil.example/'))
  assert.ok(!manifest.host_permissions.includes('<all_urls>'))
})
