/**
 * One place that knows how to talk to the service worker and the browser.
 *
 * Every worker handler replies { ok, data } or { ok, error }; send() turns a
 * failed reply back into a thrown AppError-shaped object so views can try/catch.
 */

import { originPattern, pageKind, classifyInjectError } from './access.js'

export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload })
  if (!response) {
    throw { code: 'NO_RESPONSE', message: 'The extension is restarting. Try again in a moment.' }
  }
  if (!response.ok) throw response.error
  return response.data
}

// --- the current tab -------------------------------------------------------

/**
 * The tab the user is looking at - in a NORMAL browser window.
 * From the side panel that is simply the active tab of this window. From the
 * detached window, "current" would be the detached window itself, so we ask
 * for the last focused normal window instead.
 */
export async function getActiveTab() {
  const [inCurrent] = await chrome.tabs.query({ active: true, currentWindow: true })
  // The side panel's own window is the browser window, so this is normally it.
  // Only step past it when it is the detached window (an extension page) or
  // another browser page.
  if (inCurrent && (!inCurrent.url || pageKind(inCurrent.url) !== 'browser')) return inCurrent

  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (win?.id !== undefined) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
      if (tab) return tab
    }
  } catch { /* fall through */ }

  // No focused normal window (e.g. it was minimised): any normal window's active tab.
  const tabs = await chrome.tabs.query({ active: true })
  return tabs.find((t) => t.url && pageKind(t.url) === 'site') || inCurrent || null
}

/**
 * The side panel is not an action click, so it gets no activeTab grant. The
 * first time a site is read the user is asked once; Chrome remembers.
 */
export async function hasSiteAccess(url) {
  const origin = originPattern(url)
  if (!origin) return false
  try { return await chrome.permissions.contains({ origins: [origin] }) } catch { return false }
}

/**
 * Ask Chrome for access to the tab's site. Never throws: returns
 * { granted, error } so the UI can always say what happened.
 *
 * MUST be invoked synchronously inside a click handler - Chrome requires a
 * user gesture for permissions.request, and an `await` before the call can
 * lose it. Callers pass the url they already hold; nothing is fetched first.
 */
export function requestSiteAccess(url) {
  const origin = originPattern(url)
  if (!origin) return Promise.resolve({ granted: false, error: 'This page has no web address the extension could be allowed on.' })
  try {
    return chrome.permissions.request({ origins: [origin] })
      .then((granted) => ({ granted: Boolean(granted), error: null }))
      .catch((e) => ({ granted: false, error: e?.message || String(e) }))
  } catch (e) {
    return Promise.resolve({ granted: false, error: e?.message || String(e) })
  }
}

/**
 * Inject the content script into the current tab and ask it for the tasks.
 * Errors carry a `code` the view switches on, and the `tab` so the view can
 * ask for access without querying again.
 */
export async function extractTasksFromActiveTab(selector) {
  const tab = await getActiveTab()
  if (!tab?.id) throw { code: 'NO_TAB', message: 'No open tab found. Open your Brototype task page in a tab.', tab: null }
  // Chrome only reveals a tab's url for sites the extension has host access
  // to - Brototype and nothing else, on purpose (no "tabs" permission, so the
  // extension cannot see what else is open). A tab with no url is therefore
  // some other website, not a Brototype task page.
  if (!tab.url) {
    throw { code: 'NOT_BROTOTYPE', message: 'Open a Brototype task page to get started.', tab, detail: `tab ${tab.id} in window ${tab.windowId}: url not visible to the extension` }
  }

  if (pageKind(tab.url) === 'browser') {
    throw { code: 'BAD_PAGE', message: 'This is a browser page, not a website.', tab }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  } catch (error) {
    const kind = classifyInjectError(error?.message)
    // Only blame permissions if Chrome really has none for this site. A site
    // that IS allowed but whose tab is unloaded must not loop back to "Allow".
    if (kind === 'needs-access' && !(await hasSiteAccess(tab.url))) {
      throw { code: 'NEEDS_ACCESS', message: 'Allow access to read tasks from this page.', tab }
    }
    if (kind === 'page-gone' || kind === 'needs-access') {
      throw { code: 'PAGE_NOT_READY', message: 'The page is not ready to be read. Reload the Brototype tab, then click Read Tasks.', tab, detail: error?.message }
    }
    if (kind === 'blocked') {
      throw { code: 'BAD_PAGE', message: 'Chrome does not allow extensions to read this page.', tab }
    }
    throw { code: 'INJECT_FAILED', message: "Couldn't read this page. Reload it and try again.", tab, detail: error?.message }
  }

  let result
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_TASKS', selector })
  } catch (error) {
    throw { code: 'INJECT_FAILED', message: "The page didn't answer. Reload it and click Read Tasks.", tab, detail: error?.message }
  }
  return { ...result, tabId: tab.id, url: tab.url, tabTitle: tab.title }
}

export async function startPicker() {
  const tab = await getActiveTab()
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' })
  await chrome.tabs.update(tab.id, { active: true })
  try { await chrome.windows.update(tab.windowId, { focused: true }) } catch { /* not fatal */ }
}

// --- surfaces ----------------------------------------------------------------

/** A small detached window that survives switching to other applications. */
export async function openAsWindow() {
  const url = chrome.runtime.getURL('app.html?surface=window')
  const existing = (await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }))
    .find((w) => w.tabs?.some((t) => t.url === url))
  if (existing) return chrome.windows.update(existing.id, { focused: true })
  return chrome.windows.create({ url, type: 'popup', width: 440, height: 760 })
}

export const surface = () => new URLSearchParams(location.search).get('surface')
  || (location.pathname.endsWith('app.html') && window.innerWidth > 600 ? 'tab' : 'panel')

// --- live updates --------------------------------------------------------------

/** Subscribe to job progress. Views never poll; storage tells them. */
export function watchJob(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes.job) callback(changes.job.newValue || null)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

/** Subscribe to config changes (e.g. the picker saving a selector from the page). */
export function watchConfig(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes.config) callback(changes.config.newValue || null)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

/**
 * Fire when the page beside the panel changes: a different tab, a full load,
 * OR an in-page navigation (Brototype is a single-page app, so clicking into a
 * task changes the URL without a load event). Debounced, because a SPA can
 * emit several updates for one click.
 */
export function watchActiveTab(callback) {
  let timer = null
  const fire = () => { clearTimeout(timer); timer = setTimeout(callback, 350) }
  const onActivated = () => fire()
  const onUpdated = (_id, info, tab) => { if (tab?.active && (info.status === 'complete' || info.url)) fire() }
  const onFocus = (windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) fire() }
  chrome.tabs.onActivated.addListener(onActivated)
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.windows?.onFocusChanged?.addListener(onFocus)
  return () => {
    clearTimeout(timer)
    chrome.tabs.onActivated.removeListener(onActivated)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.windows?.onFocusChanged?.removeListener(onFocus)
  }
}
