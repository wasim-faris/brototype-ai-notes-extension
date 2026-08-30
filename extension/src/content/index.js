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

import { extractFromDocument } from './extractor.js'
import { startPicker, showBanner } from './picker.js'

// Injection is idempotent: the popup may inject on every open.
if (!window.__broAiNotesLoaded) {
  window.__broAiNotesLoaded = true

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'EXTRACT_TASKS') {
      try {
        sendResponse(extractFromDocument(document, message.selector || null))
      } catch (error) {
        sendResponse({ ok: false, reason: 'extract-failed', error: String(error?.message || error), tasks: [], warnings: [] })
      }
      return false
    }

    if (message?.type === 'START_PICKER') {
      // The popup closes the moment you click the page, so the picker saves the
      // result itself instead of replying to a popup that no longer exists.
      startPicker().then(async (result) => {
        if (result.cancelled) return
        const { config = {} } = await chrome.storage.local.get('config')
        await chrome.storage.local.set({ config: { ...config, taskListSelector: result.selector } })

        const found = extractFromDocument(document, result.selector)
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
  })
}
