/**
 * student.js - the adapter for student.brototype.com.
 *
 * A different frontend from Campus (MUI instead of styled-components), so a
 * different reader, but the SAME normalised result as extractor.js: the rest
 * of the extension never learns which site it came from.
 *
 * What the page looks like, stripped of its hashed class names:
 *
 *   <h1>Task Overview</h1>  <p>Total Topics: 5</p>
 *   card ─ header:  <h6>Topic 1</h6> <p>Learn Open CV</p>  [chevron, rotated when open]
 *        └ body (only while expanded):
 *             <h6>Learn Open CV</h6>
 *             <p>Reading and displaying images\n\nWrite a short description about this task.</p>
 *             <hr> "Your Response" … "Add Attachments" … "No responses added yet"
 *
 * Every selector below is semantic - heading tags, visible text shape, the
 * parent/sibling relationships above. Nothing matches a `css-xxxx` class,
 * because MUI regenerates those on every build.
 */

import { parseSubtopics } from './parse.js'
import { elementToText } from './extractor.js'

const TOPIC_HEADING = /^\s*Topic\s+(\d+)\s*$/i
const TOTAL_TOPICS = /Total\s+Topics\s*:\s*(\d+)/i

/** Brototype's own placeholder instruction, not part of any subtopic. */
const BOILERPLATE = /^write a short description about this task\.?$/i

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim()

/**
 * Text belonging directly to this element, ignoring text inside its children -
 * so a wrapper around "Topic 1" is never mistaken for the label itself.
 */
function ownText(el) {
  let out = ''
  for (const node of el.childNodes) if (node.nodeType === 3) out += node.nodeValue
  return clean(out)
}

/**
 * Is this a Student task page? Decided by the DOM, so it also works offline
 * in tests. The "Topic N" accordion headers are the signature; "Task Overview"
 * is a second, optional confirmation - a page can carry the accordion under a
 * differently-tagged heading and still be this site.
 */
export function isStudentPage(doc) {
  const topics = findTopicHeadings(doc)
  if (!topics.length) return false
  if (topics.length >= 2) return true
  return [...doc.querySelectorAll('h1,h2,h3,h4,p,div,span')].some((h) => /^task overview$/i.test(ownText(h)))
}

// Elements that could carry a "Topic N" label. Headings first, but a future
// build may render it as a <p>, <div> or <span> - what matters is the text.
const TOPIC_CANDIDATES = 'h1,h2,h3,h4,h5,h6,p,div,span,strong,b'

/**
 * The "Topic N" text of a small element: its own text, or - when the number
 * sits in a child node ("Topic <span>5</span>") - its whole text, provided the
 * element is a leaf-sized label and not a wrapper around the card.
 */
function labelText(el) {
  const own = ownText(el)
  if (TOPIC_HEADING.test(own)) return own
  if (el.querySelectorAll('*').length > 3) return ''
  return clean(el.textContent)
}

/**
 * Every "Topic N" label, in document order, each number once. If an element
 * and its wrapper both read "Topic 1" (a <span> inside an <h6>), the outermost
 * is kept so the walk to the card starts from the same place every time.
 */
function findTopicHeadings(root) {
  const seen = new Map()
  for (const el of root.querySelectorAll(TOPIC_CANDIDATES)) {
    const match = labelText(el).match(TOPIC_HEADING)
    if (!match) continue
    const number = Number(match[1])
    const prior = seen.get(number)
    if (prior && (prior.el.contains(el) || !el.contains(prior.el))) continue
    seen.set(number, { el, number })
  }
  return [...seen.values()].sort((a, b) => a.number - b.number)
}

/** Does this element's text match the topic title, with or without its "N)." marker? */
const isTitleText = (text, title) => stripTopicMarker(text).toLowerCase() === title.toLowerCase()

/** Text lines that mean "the task content has ended"; nothing past them is task content. */
const END_OF_TASK = /^(your response|add attachments?|no responses? added yet|mark as completed|request task explanation|report an issue)$/i
const CHROME_TEXT = /^(\d+\s+attachments?\s+added|mark as completed|request task explanation|report an issue)$/i

/** "1). State Management with Redux" -> "State Management with Redux"; the number is already known. */
const stripTopicMarker = (text) => clean(text).replace(/^\(?\d{1,3}\s*[).\]]+\s*[).\]]*\s*/, '').trim()

/** The card that owns a "Topic N" heading: the nearest ancestor that also holds a second heading (the expanded body) or, failing that, the header row's parent. */
function cardOf(headingEl) {
  // The header row is the heading's grandparent (icon | text block | chevron).
  // The card is that row's parent; the expanded body, when present, is the
  // row's next sibling. Walk up a bounded number of levels to be tolerant of
  // an extra wrapper appearing in a future build.
  let row = headingEl.parentElement
  for (let i = 0; row && i < 3; i++) {
    if (row.parentElement && [...row.parentElement.children].length >= 1 && row.querySelector('svg, [style*="transform"]')) break
    row = row.parentElement
  }
  return { row, card: row?.parentElement || null }
}

/**
 * Is this topic expanded? Three independent signals, any one is enough:
 * the chevron is rotated, the body sibling is visible, or the body simply
 * exists with a heading repeating the topic title.
 */
function isExpanded(row, body) {
  const chevron = row?.querySelector('[style*="rotate"]')
  if (chevron && /rotate\(\s*180deg\s*\)/.test(chevron.getAttribute('style') || '')) return true
  if (!body) return false
  const style = body.getAttribute('style') || ''
  if (/opacity:\s*0\b|height:\s*0(px)?\b|display:\s*none/.test(style)) return false
  return Boolean(body.querySelector('h1,h2,h3,h4,h5,h6'))
}


/**
 * Main entry point for the Student site. Same shape as extractor.js's result.
 * Collapsed topics contribute their title only; the warning tells the user to
 * expand a topic so its details can be read.
 */
export function extractFromStudentDocument(doc) {
  const warnings = []
  const headings = findTopicHeadings(doc)
  if (!headings.length) {
    return { ok: false, source: 'scan', site: 'student', unit: null, tasks: [], warnings, reason: 'no-tasks' }
  }

  const labels = headings.map((h) => h.el)
  const tasks = headings.map(({ el, number }) => readTopic(el, number, labels))
  return finish(doc, tasks, warnings)
}

/**
 * The topic's title element: the text block right beside the "Topic N" label.
 * First a following sibling with text, then the nearest wrapper's first
 * paragraph-like element that is not the label itself.
 */
function titleElementOf(labelEl) {
  for (let sib = labelEl.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (clean(sib.textContent) && !CHROME_TEXT.test(clean(sib.textContent))) return sib
  }
  for (let node = labelEl.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
    for (const cand of node.querySelectorAll('p,span,div,h1,h2,h3,h4,h5,h6')) {
      if (cand === labelEl || cand.contains(labelEl) || labelEl.contains(cand)) continue
      const text = ownText(cand)
      if (text && !TOPIC_HEADING.test(text) && !CHROME_TEXT.test(text)) return cand
    }
  }
  return null
}

/**
 * Everything about one topic that the DOM can tell us right now.
 *
 * The card is found structurally, not by wrapper count: climb from the label
 * until an ancestor contains the task title REPEATED outside the header (that
 * repeat is the first line of the expanded body), stopping before any ancestor
 * that also contains another "Topic M" - that one is the list, not a card.
 * A collapsed topic has no repeat, so its card is the highest ancestor below
 * the list; that is enough to know it is collapsed.
 */
function partsOf(labelEl, allLabels = []) {
  const others = allLabels.filter((l) => l !== labelEl)
  const titleEl = titleElementOf(labelEl)
  const title = stripTopicMarker(titleEl?.textContent)
  const { row } = cardOf(labelEl)

  let card = null
  let bodyTitle = null
  for (let node = labelEl.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    if (others.some((o) => node.contains(o))) break     // reached the list of topics
    card = node
    if (!title) continue
    const repeat = [...node.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span,strong,b')].find((cand) =>
      cand !== titleEl && cand !== labelEl && !row?.contains(cand) && !cand.contains(labelEl) && isTitleText(ownText(cand), title))
    if (repeat) { bodyTitle = repeat; break }
  }

  // The body is the block that holds the repeated title: its highest ancestor
  // that is still below the header row's parent level, i.e. inside the card
  // but not part of the header.
  let body = null
  if (bodyTitle) {
    body = bodyTitle
    while (body.parentElement && body.parentElement !== card && !body.parentElement.contains(labelEl)) body = body.parentElement
    if (body.parentElement !== card) body = bodyTitle.parentElement   // unusual nesting: settle for the immediate block
  }
  return { row, card, titleEl, title, bodyTitle, body }
}

/** Is any element between `body` and `card` hidden by an inline style? */
function hiddenByStyle(body, card) {
  for (let node = body; node && node !== card; node = node.parentElement) {
    const style = node.getAttribute?.('style') || ''
    if (/opacity:\s*0(\.0+)?\b(?!\.\d)|height:\s*0(px)?\s*(;|$)|display:\s*none|visibility:\s*hidden/.test(style)) return true
  }
  return false
}

/**
 * The task content of an expanded topic: every line after the repeated title
 * up to "Your Response" (or any other piece of the response widget), minus
 * Brototype's "Write a short description…" boilerplate and the title itself.
 * Looks at the title's following siblings first, then its wrapper's, so an
 * extra <div> around the paragraph changes nothing.
 */
function readBodyText(bodyTitle, title) {
  const lines = []
  const take = (el) => {
    if (el.querySelector?.(FORM_CONTROLS)) return false
    for (const line of elementToText(el).split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (END_OF_TASK.test(line)) return false
      if (BOILERPLATE.test(line) || CHROME_TEXT.test(line) || isTitleText(line, title)) continue
      lines.push(line)
    }
    return true
  }
  for (let node = bodyTitle, depth = 0; node && depth < 3 && !lines.length; node = node.parentElement, depth++) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (/^hr$/i.test(sib.tagName)) break
      if (!take(sib)) break
    }
  }
  return lines.join('\n')
}

const FORM_CONTROLS = 'textarea,input,select'

/** One topic as it is on the page right now. */
function readTopic(el, number, allLabels = []) {
  const parts = partsOf(el, allLabels)
  const title = parts.title || `Topic ${number}`
  const rendered = Boolean(parts.bodyTitle) && !hiddenByStyle(parts.body, parts.card)
  const expanded = rendered || isExpanded(parts.row, null)
  const raw = rendered ? readBodyText(parts.bodyTitle, title) : ''
  return {
    number, title, subtopics: parseSubtopics(raw), raw, expanded,
    // Development diagnostics: which elements were used, so a layout change
    // can be read off the panel's log instead of guessed at.
    diagnostics: {
      label: describe(el), card: describe(parts.card), bodyTitle: describe(parts.bodyTitle),
      body: describe(parts.body), rendered, bodyText: raw.slice(0, 160),
    },
  }
}

const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` : null)

/** Shared tail of both readers: order, warnings, unit, the normalised result. */
function finish(doc, tasks, warnings) {
  tasks.sort((a, b) => a.number - b.number)

  const collapsed = tasks.filter((t) => !t.expanded)
  if (collapsed.length) {
    warnings.push(`${collapsed.length} topic(s) are collapsed on the page, so only their titles were read: ${collapsed.map((t) => t.number).join(', ')}. Expand a topic on the Student page and press Rescan to include its details.`)
  }

  const totalText = clean(doc.body?.textContent).match(TOTAL_TOPICS)
  const total = totalText ? Number(totalText[1]) : tasks.length
  if (total !== tasks.length) {
    warnings.push(`The page says ${total} topics but ${tasks.length} were found — check nothing was missed.`)
  }

  const unit = {
    title: pageHeading(doc) || 'Brototype Tasks',
    sem: null, paper: null, module: null, week: null, status: null, type: null,
    site: 'student',
    totalTopics: total,
  }

  return {
    ok: true,
    source: 'scan',
    site: 'student',
    unit,
    pageTitle: unit.title,
    tasks,
    warnings,
  }
}

/** A page title other than "Task Overview", if the page has one; else the tab title. */
function pageHeading(doc) {
  for (const h of doc.querySelectorAll('h1,h2')) {
    const text = clean(h.textContent)
    if (text && !/^task overview$/i.test(text) && !TOPIC_HEADING.test(text)) return text
  }
  const tab = clean(doc.title)
  return tab && !/^task overview$/i.test(tab) ? tab : ''
}

// --- expanding every topic ---------------------------------------------------
//
// The Student page is an accordion: at most one topic shows its body at a
// time, so a plain read sees one topic's details and four titles. This reader
// opens each collapsed topic itself, waits for React/MUI to render the body,
// reads it, and finally puts the page back the way the student had it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until `check()` is truthy, watching the DOM rather than polling blindly. */
function waitFor(doc, check, timeoutMs) {
  return new Promise((resolve) => {
    if (check()) return resolve(true)
    let done = false
    const finishWith = (value) => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); resolve(value) }
    const observer = new (doc.defaultView?.MutationObserver || globalThis.MutationObserver)(() => { if (check()) finishWith(true) })
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    const timer = setTimeout(() => finishWith(Boolean(check())), timeoutMs)
  })
}

/** Is topic `el` showing a rendered, visible body with some task content? */
function bodyReady(el, labels) {
  const parts = partsOf(el, labels)
  if (!parts.bodyTitle || hiddenByStyle(parts.body, parts.card)) return false
  return readBodyText(parts.bodyTitle, parts.title).length > 0 || Boolean(parts.body)
}

/** The MUI accordion animates height; wait for it to stop moving before reading. */
async function settled(doc, el, timeoutMs, labels) {
  const style = () => partsOf(el, labels).body?.getAttribute('style') || ''
  const start = Date.now()
  let last = style()
  while (Date.now() - start < timeoutMs) {
    if (!/height:\s*\d+px/.test(last) || /height:\s*auto/.test(last)) return
    await sleep(60)
    const now = style()
    if (now === last) return
    last = now
  }
}

/**
 * A topic is toggled by clicking its label - the same thing a student does.
 * The click bubbles up through every wrapper to wherever the page listens,
 * so it works whether the handler is on the row, the card, or the label.
 */
const toggle = (el) => el.click?.()

/**
 * Read every topic, expanding collapsed ones as needed. Resolves to the same
 * shape as extractFromStudentDocument. Topics that will not open in time are
 * read title-only and named in a warning; nothing is invented.
 *
 * `timeoutMs` bounds each expansion. `restore` puts the page back afterwards.
 */
export async function extractFromStudentDocumentExpanding(doc, { timeoutMs = 2500, restore = true } = {}) {
  const warnings = []
  const headings = findTopicHeadings(doc)
  if (!headings.length) {
    return { ok: false, source: 'scan', site: 'student', unit: null, tasks: [], warnings, reason: 'no-tasks' }
  }

  const labels = headings.map((h) => h.el)
  const isOpen = (el) => readTopic(el, 0, labels).expanded
  const initiallyOpen = headings.filter(({ el }) => isOpen(el)).map((h) => h.number)
  const tasks = []
  const failed = []
  const opened = []

  for (const { el, number } of headings) {
    // Already showing its body - read it, never click it (that would close it).
    if (bodyReady(el, labels)) { tasks.push(readTopic(el, number, labels)); continue }

    if (!isOpen(el)) {
      toggle(el)
      opened.push(number)
    }
    const ready = await waitFor(doc, () => bodyReady(el, labels), timeoutMs)
    if (ready) await settled(doc, el, Math.min(timeoutMs, 1500), labels)

    // Read and keep it NOW: opening the next topic may close this one.
    const task = readTopic(el, number, labels)
    if (!ready || !task.expanded) failed.push(number)
    tasks.push(task)
  }

  if (restore) {
    // Close what this scan opened (only if still open), reopen what the
    // student had open. An accordion may have closed some of these already.
    for (const number of opened) {
      const h = headings.find((x) => x.number === number)
      if (h && !initiallyOpen.includes(number) && isOpen(h.el)) toggle(h.el)
    }
    for (const number of initiallyOpen) {
      const h = headings.find((x) => x.number === number)
      if (h && !isOpen(h.el)) toggle(h.el)
    }
  }

  if (failed.length) {
    warnings.push(`${failed.length} topic(s) could not be expanded, so only their titles were read: ${failed.join(', ')}. Expand them on the page and press Rescan, or generate from the title alone.`)
  }

  const result = finish(doc, tasks, warnings)
  // finish() warns about collapsed topics from the page's point of view; after
  // an expanding scan the only honest "collapsed" warning is the failure list.
  result.warnings = result.warnings.filter((w) => !/are collapsed on the page/.test(w))
  result.expandedByExtension = opened
  return result
}
