/**
 * access.js - pure helpers for the "can we read this tab?" flow.
 *
 * No chrome.* calls here, so every rule is unit-testable. messaging.js does
 * the actual browser calls and GenerateView shows the states.
 */

/** "https://learn.brototype.com/path?x" -> "https://learn.brototype.com/*" */
export function originPattern(url) {
  try {
    const { protocol, origin } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return null
    return `${origin}/*`
  } catch {
    return null
  }
}

/**
 * What kind of page is in the tab, for the empty state:
 *   'browser'  chrome://, edge://, the extension's own pages - cannot be read
 *   'none'     no tab / no url at all
 *   'site'     an ordinary http(s) page
 */
export function pageKind(url) {
  if (!url) return 'none'
  if (/^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i.test(url)) return 'browser'
  return /^https?:/i.test(url) ? 'site' : 'none'
}

export const isBrototypeHost = (url) => {
  try { return /brototype/i.test(new URL(url).hostname) } catch { return false }
}

export const hostOf = (url) => { try { return new URL(url).host } catch { return '' } }

/**
 * chrome.scripting.executeScript failures, sorted into what the user can do.
 *   'needs-access'  the manifest has no permission for this host (ask once)
 *   'page-gone'     tab discarded / closed / still loading - reload and retry
 *   'blocked'       a page Chrome never lets extensions touch (web store, PDFs…)
 *   'unknown'
 */
export function classifyInjectError(message = '') {
  const m = String(message)
  // Most specific first: "cannot be scripted" also appears in the gallery message.
  if (/extensions gallery|cannot access a chrome|cannot access chrome/i.test(m)) return 'blocked'
  if (/must request permission|cannot access contents of (the )?(url|page)|host permission/i.test(m)) return 'needs-access'
  if (/no tab with id|tab was closed|tab was discarded|frame was removed|cannot be scripted|document is not available/i.test(m)) return 'page-gone'
  return 'unknown'
}

/** What happened when we asked Chrome for site access. */
export function describeAccessResult({ granted, error }, url) {
  const host = hostOf(url) || 'this site'
  if (granted) return { state: 'granted', message: `Access to ${host} granted.` }
  if (error) {
    if (/user gesture/i.test(error)) {
      return { state: 'error', message: 'Chrome needs a direct click to ask for access. Click "Allow & Read Tasks" again.' }
    }
    return { state: 'error', message: `Chrome could not ask for access to ${host}.`, detail: error }
  }
  return { state: 'denied', message: `Access to ${host} was not granted. Click "Allow & Read Tasks" and choose Allow in Chrome's prompt.` }
}
