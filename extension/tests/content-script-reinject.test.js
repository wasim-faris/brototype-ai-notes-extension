import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * REGRESSION: the content script is injected on every Rescan, but it used to
 * register its message listener only once per tab. After a rebuild + reload of
 * the extension, the FIRST version injected into an already-open Brototype tab
 * kept answering - a stale reader returning stale results (on the Student site:
 * the Campus reader's "had no subtopics" warning) until the tab was reloaded.
 *
 * Now each injection replaces the previous listener, so the newest code
 * answers. This test injects the script twice and checks that only the second
 * registration is live.
 */

const HTML = readFileSync(new URL('../../fixtures/brototype-student-real.html', import.meta.url), 'utf8')
const dom = new JSDOM(HTML, { url: 'https://student.brototype.com/tasks/module/details?id=1' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location

const listeners = []
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) },
    },
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
}

const inject = () => import(`../src/content/index.js?injection=${Math.random()}`)

test('a second injection replaces the first listener instead of being ignored', async () => {
  await inject()
  assert.equal(listeners.length, 1)
  const first = listeners[0]

  await inject()
  assert.equal(listeners.length, 1, 'exactly one listener is live')
  assert.notEqual(listeners[0], first, 'and it is the newest one')
  assert.equal(window.__broAiNotesListener, listeners[0])
  assert.equal(window.__broAiNotesLoaded, undefined, 'the once-per-tab flag is gone')
})

test('the live listener answers EXTRACT_TASKS with the Student reader\'s result, asynchronously', async () => {
  const reply = await new Promise((resolve) => {
    const keepOpen = listeners[0]({ type: 'EXTRACT_TASKS', selector: null }, {}, resolve)
    assert.equal(keepOpen, true, 'returns true so Chrome keeps the channel open for the async reply')
  })
  assert.equal(reply.site, 'student')
  assert.equal(reply.tasks.length, 6)
  assert.equal(reply.tasks[0].title, 'State Management with Redux')
  assert.equal(reply.tasks[0].subtopics.length, 4)
  assert.ok(!reply.warnings.some((w) => /had no subtopics detected/.test(w)), 'never the Campus warning on a Student page')
})
