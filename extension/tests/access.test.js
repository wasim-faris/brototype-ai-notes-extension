import test from 'node:test'
import assert from 'node:assert/strict'
import { originPattern, pageKind, classifyInjectError, describeAccessResult, isBrototypeHost, hostOf } from '../src/ui/access.js'

/**
 * The "Allow & Read Tasks" flow. The pure rules are tested directly; the
 * browser calls in messaging.js are tested against a fake `chrome` so the
 * exact failure modes that made the button look dead are pinned:
 *   - the user clicks Block             → { granted: false } → a "denied" message
 *   - Chrome rejects the request        → { error }          → an "error" message
 *   - the tab has no web URL            → no throw, clear message
 *   - the detached window is focused    → the NORMAL window's tab is read
 *   - a granted site whose tab is stale → "reload", never "allow" again
 */

// --- pure helpers -----------------------------------------------------------

test('originPattern covers the whole site and rejects non-web pages', () => {
  assert.equal(originPattern('https://learn.brototype.com/tasks/12?x=1'), 'https://learn.brototype.com/*')
  assert.equal(originPattern('http://localhost:3000/a'), 'http://localhost:3000/*')
  assert.equal(originPattern('chrome://extensions'), null)
  assert.equal(originPattern('chrome-extension://abc/app.html'), null)
  assert.equal(originPattern(undefined), null)
})

test('pageKind tells browser pages from sites', () => {
  assert.equal(pageKind('https://learn.brototype.com/'), 'site')
  assert.equal(pageKind('chrome://newtab'), 'browser')
  assert.equal(pageKind('chrome-extension://abc/app.html'), 'browser')
  assert.equal(pageKind('file:///x.pdf'), 'browser')
  assert.equal(pageKind(''), 'none')
})

test('inject errors are classified by what the user can do about them', () => {
  assert.equal(classifyInjectError('Cannot access contents of url "https://x". Extension manifest must request permission to access this host.'), 'needs-access')
  assert.equal(classifyInjectError('No tab with id: 42.'), 'page-gone')
  assert.equal(classifyInjectError('The tab was closed.'), 'page-gone')
  assert.equal(classifyInjectError('The extensions gallery cannot be scripted.'), 'blocked')
  assert.equal(classifyInjectError('something odd'), 'unknown')
})

test('the access result is always explained in plain words', () => {
  const url = 'https://learn.brototype.com/x'
  assert.deepEqual(describeAccessResult({ granted: true }, url), { state: 'granted', message: 'Access to learn.brototype.com granted.' })
  assert.equal(describeAccessResult({ granted: false, error: null }, url).state, 'denied')
  assert.match(describeAccessResult({ granted: false, error: null }, url).message, /choose Allow/)
  const gesture = describeAccessResult({ granted: false, error: 'This function must be called during a user gesture' }, url)
  assert.equal(gesture.state, 'error')
  assert.match(gesture.message, /direct click/)
  assert.ok(!/chrome\.runtime|lastError/.test(gesture.message), 'no technical wording in the headline')
  assert.equal(describeAccessResult({ granted: false, error: 'boom' }, url).detail, 'boom')
  assert.equal(isBrototypeHost('https://learn.brototype.com/'), true)
  assert.equal(hostOf('nonsense'), '')
})

// --- messaging.js against a fake chrome ------------------------------------------

const NORMAL_TAB = { id: 7, windowId: 1, active: true, url: 'https://learn.brototype.com/tasks', title: 'Brototype' }
const PANEL_TAB = { id: 9, windowId: 2, active: true, url: 'chrome-extension://abc/app.html?surface=window' }

function fakeChrome({ currentTab = NORMAL_TAB, granted = true, requestImpl, injectError, contains = false, extractReply } = {}) {
  const calls = { request: [], inject: [] }
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://abc/${p}`, sendMessage: async () => ({ ok: true, data: {} }) },
    tabs: {
      query: async (q) => {
        if (q.currentWindow) return [currentTab]
        if (q.windowId === 1) return [NORMAL_TAB]
        if (q.active) return [NORMAL_TAB, PANEL_TAB]
        return []
      },
      sendMessage: async () => extractReply ?? { ok: true, tasks: [{ number: 1, title: 't', subtopics: [] }], unit: {}, pageTitle: 'p', warnings: [] },
      update: async () => {},
      onActivated: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: { getLastFocused: async () => ({ id: 1 }), update: async () => {}, getAll: async () => [], WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {}, removeListener() {} } },
    scripting: { executeScript: async (opts) => { calls.inject.push(opts); if (injectError) throw new Error(injectError) } },
    permissions: {
      contains: async () => contains,
      request: requestImpl || (async (opts) => { calls.request.push(opts); return granted }),
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  }
  return calls
}

const messaging = () => import('../src/ui/messaging.js?' + Math.random()) // fresh module per test is not needed; helpers are stateless

test('requestSiteAccess asks for exactly the site pattern and reports Allow', async () => {
  const calls = fakeChrome({ granted: true })
  const { requestSiteAccess } = await messaging()
  assert.deepEqual(await requestSiteAccess(NORMAL_TAB.url), { granted: true, error: null })
  assert.deepEqual(calls.request[0], { origins: ['https://learn.brototype.com/*'] })
})

test('requestSiteAccess reports Block as denied, never as nothing', async () => {
  fakeChrome({ granted: false })
  const { requestSiteAccess } = await messaging()
  assert.deepEqual(await requestSiteAccess(NORMAL_TAB.url), { granted: false, error: null })
})

test('requestSiteAccess never throws: a rejected Chrome call becomes an explained error', async () => {
  fakeChrome({ requestImpl: async () => { throw new Error('This function must be called during a user gesture') } })
  const { requestSiteAccess } = await messaging()
  const out = await requestSiteAccess(NORMAL_TAB.url)
  assert.equal(out.granted, false)
  assert.match(out.error, /user gesture/)
  assert.equal(describeAccessResult(out, NORMAL_TAB.url).state, 'error')
})

test('requestSiteAccess on a page with no web URL explains instead of silently failing', async () => {
  fakeChrome()
  const { requestSiteAccess } = await messaging()
  const out = await requestSiteAccess('chrome://extensions')
  assert.equal(out.granted, false)
  assert.match(out.error, /no web address/)
})

test('requestSiteAccess calls chrome.permissions.request synchronously (the user gesture survives)', async () => {
  let calledSync = false
  fakeChrome({ requestImpl: () => { calledSync = true; return Promise.resolve(true) } })
  const { requestSiteAccess } = await messaging()
  const pending = requestSiteAccess(NORMAL_TAB.url)   // no await yet
  assert.equal(calledSync, true, 'request must fire before any await, or Chrome drops the gesture')
  await pending
})

test('getActiveTab from the detached window reads the NORMAL window, not itself', async () => {
  fakeChrome({ currentTab: PANEL_TAB })
  const { getActiveTab } = await messaging()
  const tab = await getActiveTab()
  assert.equal(tab.id, NORMAL_TAB.id)
})

test('a site with no permission yields NEEDS_ACCESS with the tab attached', async () => {
  fakeChrome({ injectError: 'Cannot access contents of url "https://learn.brototype.com/tasks". Extension manifest must request permission to access this host.', contains: false })
  const { extractTasksFromActiveTab } = await messaging()
  await assert.rejects(() => extractTasksFromActiveTab(null), (e) => {
    assert.equal(e.code, 'NEEDS_ACCESS')
    assert.equal(e.tab.url, NORMAL_TAB.url)
    return true
  })
})

test('a site that IS allowed but whose tab is stale says "reload", never "allow" again', async () => {
  fakeChrome({ injectError: 'Cannot access contents of the page. Extension manifest must request permission to access this host.', contains: true })
  const { extractTasksFromActiveTab } = await messaging()
  await assert.rejects(() => extractTasksFromActiveTab(null), (e) => {
    assert.equal(e.code, 'PAGE_NOT_READY')
    assert.match(e.message, /Reload/)
    return true
  })
})

test('a browser page is reported as unsupported, not as a permission problem', async () => {
  fakeChrome({ currentTab: { id: 3, windowId: 1, active: true, url: 'chrome://newtab' } })
  globalThis.chrome.windows.getLastFocused = async () => { throw new Error('no window') }
  globalThis.chrome.tabs.query = async (q) => (q.currentWindow ? [{ id: 3, windowId: 1, active: true, url: 'chrome://newtab' }] : [])
  const { extractTasksFromActiveTab } = await messaging()
  await assert.rejects(() => extractTasksFromActiveTab(null), (e) => e.code === 'BAD_PAGE')
})

test('a successful read returns the tasks with the tab it came from', async () => {
  fakeChrome()
  const { extractTasksFromActiveTab } = await messaging()
  const r = await extractTasksFromActiveTab(null)
  assert.equal(r.ok, true)
  assert.equal(r.url, NORMAL_TAB.url)
  assert.equal(r.tasks.length, 1)
})

test.after(() => { delete globalThis.chrome })

// --- Chrome hides tab.url for sites the extension has no host access to ---------

test('a tab whose url Chrome hid is some other website: "open a Brototype page", not "no page" and not "reload"', async () => {
  const hidden = { id: 7, windowId: 1, active: true }   // exactly what tabs.query returns for a non-Brototype site
  fakeChrome({ currentTab: hidden })
  globalThis.chrome.tabs.query = async (q) => (q.currentWindow ? [hidden] : [])
  const { extractTasksFromActiveTab } = await messaging()
  await assert.rejects(() => extractTasksFromActiveTab(null), (e) => {
    assert.notEqual(e.code, 'NO_TAB', 'the tab exists - saying "no page" is a lie')
    assert.equal(e.code, 'NOT_BROTOTYPE')
    assert.match(e.message, /Brototype task page/, 'says what to open')
    assert.equal(e.tab.id, 7, 'keeps the tab it found')
    return true
  })
})

test('the side panel window is used as-is when its active tab is a web page', async () => {
  fakeChrome({ currentTab: NORMAL_TAB })
  let askedLastFocused = false
  globalThis.chrome.windows.getLastFocused = async () => { askedLastFocused = true; return { id: 1 } }
  const { getActiveTab } = await messaging()
  const tab = await getActiveTab()
  assert.equal(tab.id, NORMAL_TAB.id)
  assert.equal(askedLastFocused, false, 'no detour through other windows when the panel window has the page')
})

test('the manifest reads Brototype without a prompt and sees no other tab urls', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  // No "tabs": that would show "Read your browsing history" on the Web Store.
  // Host access to brototype.com already reveals those tabs' urls, which is
  // all the panel needs; every other tab is invisible, by design.
  assert.ok(!manifest.permissions.includes('tabs'))
  assert.ok(!manifest.optional_host_permissions, 'no request for access to arbitrary sites')
  assert.ok(manifest.host_permissions.includes('https://*.brototype.com/*'))
  // and a campus URL matches that pattern
  const pattern = /^https:\/\/([^/]+\.)?brototype\.com\//
  assert.ok(pattern.test('https://campus.brototype.com/tasks/123'))
})
