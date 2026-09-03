/**
 * sites.js - which Brototype site is this, and which reader understands it?
 *
 *   campus.brototype.com   -> extractor.js   (the original, untouched)
 *   student.brototype.com  -> student.js
 *
 * Both return the same normalised object, so everything after this point -
 * task selection, AI generation, Notion - is site-agnostic.
 *
 * Detection is by DOM fingerprint first and hostname second: the Student
 * layout is unmistakable ("Task Overview" + "Topic N" headings), and deciding
 * from the document means a saved page or a test fixture is read correctly
 * without a URL. The hostname only breaks a tie when the fingerprint is absent.
 */

import { extractFromDocument } from './extractor.js'
import { extractFromStudentDocument, extractFromStudentDocumentExpanding, isStudentPage } from './student.js'

export const SITES = {
  campus: { label: 'Brototype Campus', hosts: /(^|\.)campus\.brototype\.com$/i },
  student: { label: 'Brototype Student', hosts: /(^|\.)student\.brototype\.com$/i },
}

/** 'campus' | 'student' | null, from a URL alone. */
export function siteFromUrl(url) {
  let host
  try { host = new URL(url).hostname } catch { return null }
  for (const [id, site] of Object.entries(SITES)) if (site.hosts.test(host)) return id
  return null
}

/**
 * 'campus' | 'student'. The hostname is decisive when it names a site: on
 * student.brototype.com the Student reader runs even if the page is mid-render
 * and the fingerprint is not visible yet. Without a recognised hostname (a
 * saved page, a fixture) the DOM fingerprint decides.
 */
export function detectSite(doc, url = doc?.location?.href) {
  const byUrl = siteFromUrl(url)
  if (byUrl) return byUrl
  return isStudentPage(doc) ? 'student' : 'campus'
}

/**
 * On the Student site, a page with no "Topic N" accordion at all (a different
 * Student page, or a layout change) is handed to the Campus reader rather than
 * reported as empty - that reader is structural and may still find a list.
 */
const studentOrFallback = (doc, savedSelector, result) =>
  result.ok || result.reason !== 'no-tasks' ? result : { site: 'campus', ...extractFromDocument(doc, savedSelector) }

/** The one call the content script makes. */
export function extractTasks(doc, savedSelector = null, url) {
  const site = detectSite(doc, url)
  if (site === 'student') return studentOrFallback(doc, savedSelector, extractFromStudentDocument(doc))
  // Campus: exactly what it always did, saved selector included.
  return { site: 'campus', ...extractFromDocument(doc, savedSelector) }
}

/**
 * The same, but on the Student site every topic is opened and read. Async
 * because expanding an accordion means waiting for the page to render. Campus
 * is unaffected: its result is returned synchronously-computed, just wrapped.
 */
export async function extractTasksExpanding(doc, savedSelector = null, url, options) {
  const site = detectSite(doc, url)
  if (site === 'student') return studentOrFallback(doc, savedSelector, await extractFromStudentDocumentExpanding(doc, options))
  return { site: 'campus', ...extractFromDocument(doc, savedSelector) }
}
