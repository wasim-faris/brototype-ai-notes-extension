/**
 * The content script. Bundled to ONE classic-script file (see vite.content.config.js).
 *
 * It is injected on demand by the popup - there is no `content_scripts` entry in
 * manifest.json. That means:
 *   - the extension needs no permission for Brototype's domain in advance,
 *     which is good privacy hygiene and also means it keeps working if
 *     Brototype ever moves to a new URL;
 *   - it only ever runs on the tab you had open when you clicked the icon.
 */

import { extractTasks, extractTasksExpanding } from './sites.js'
import { startPicker, showBanner } from './picker.js'

const DEV_BUILD = typeof __DEV_BUILD__ === 'boolean' ? __DEV_BUILD__ : true

/**
 * Injection happens on every Rescan. Registering the listener only once per
 * tab (the previous "loaded" flag) meant the FIRST version ever injected kept
 * answering for the life of the tab, even after the extension was rebuilt and
 * reloaded - a stale reader silently serving stale results. So each injection
 * replaces the previous listener instead: the newest code always answers.
 */
if (window.__broAiNotesListener) {
  try { chrome.runtime.onMessage.removeListener(window.__broAiNotesListener) } catch { /* already gone */ }
}

const listener = (message, _sender, sendResponse) => {

  if (message?.type === 'EXTRACT_TASKS') {
    // Async, because the Student site's accordion has to be opened topic by
    // topic and read as each one renders. Campus resolves immediately.
    extractTasksExpanding(document, message.selector || null, location.href)
      .then((result) => {
        // Development builds only: which elements each Student topic was read
        // from, so a layout change on the live site can be diagnosed from the
        // page console. Compiled out of a release build.
        if (DEV_BUILD && result?.site === 'student') {
          console.debug('[Brototype AI Notes] student topics', result.tasks.map((t) => ({ number: t.number, title: t.title, subtopics: t.subtopics.map((s) => s.title), ...t.diagnostics })))
        }
        sendResponse(result)
      })
      .catch((error) => sendResponse({ ok: false, reason: 'extract-failed', error: String(error?.message || error), tasks: [], warnings: [] }))
    return true // keep the channel open for the async reply
  }

  if (message?.type === 'START_PICKER') {
    // The popup closes the moment you click the page, so the picker saves the
    // result itself instead of replying to a popup that no longer exists.
    startPicker().then(async (result) => {
      if (result.cancelled) return
      const { config = {} } = await chrome.storage.local.get('config')
      await chrome.storage.local.set({ config: { ...config, taskListSelector: result.selector } })

      const found = extractTasks(document, result.selector, location.href)
      const banner = showBanner(
        found.ok
          ? `✅ Saved. ${found.tasks.length} task(s) found — the panel is re-reading the page.`
          : '⚠️ No tasks found inside that box. Try clicking a larger area.',
      )
      setTimeout(() => banner.remove(), 4000)
    })
    sendResponse({ started: true })
    return false
  }

  return false
}
window.__broAiNotesListener = listener
chrome.runtime.onMessage.addListener(listener)
