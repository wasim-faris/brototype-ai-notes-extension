/**
 * extractor.js - THE ONLY FILE IN THIS PROJECT THAT KNOWS ABOUT BROTOTYPE.
 *
 * Everything downstream (AI, Notion, UI) consumes the normalised object this
 * file returns. If Brototype redesigns their site, this is the file to fix and
 * nothing else needs to change.
 *
 * Design rule learned from the real page:
 *   Brototype's frontend uses styled-components, so class names look like
 *   "sc-gSILEF fXTRBO". Those hashes are REGENERATED ON EVERY BROTOTYPE BUILD.
 *   Selecting on them would break within weeks. So we select on STRUCTURE and
 *   TEXT SHAPE instead: "an element whose own text starts with `1.`", and
 *   "the paragraph sitting next to it".
 */

import { parseSubtopics, parseTaskHeading } from './parse.js'

// Elements that could plausibly hold a task title. Deliberately broad.
const HEADING_CANDIDATES = 'h1,h2,h3,h4,h5,h6,p,div,span,li,strong,b,a,td'

// If a container holds any of these it is an input widget, not task content.
const FORM_CONTROLS = 'textarea,input,select,button'
const FORM_CONTROL_TAGS = new Set(['textarea', 'input', 'select', 'button', 'label'])

/** Text belonging directly to this element, ignoring text inside its children. */
function ownText(el) {
  let out = ''
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.nodeValue
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Read an element as text while PRESERVING line breaks.
 * Brototype puts all subtopics in one <p> separated by real newlines, but a
 * future redesign might use <br> or <li>. This handles all three.
 */
const BLOCK_TAGS = /^(p|div|li|tr|section|article|header|footer|main|aside|nav|h[1-6]|dt|dd|figure|blockquote|pre|fieldset)$/

/** Does this element start a new visual line? CSS first, tag name as fallback. */
function isBlockLevel(node, tag) {
  try {
    const view = node.ownerDocument?.defaultView
    const display = view?.getComputedStyle?.(node)?.display
    if (display) {
      if (display === 'inline' || display === 'contents' || display === 'none') return BLOCK_TAGS.test(tag)
      return true   // block, flex, grid, list-item, table-*, inline-block…
    }
  } catch { /* no view, or a node style cannot be computed: fall through */ }
  return BLOCK_TAGS.test(tag)
}

function elementToText(el) {
  const parts = []
  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue)
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()
    if (tag === 'br') return void parts.push('\n')
    if (tag === 'script' || tag === 'style') return

    // Tag name is only a hint: CSS decides the real layout, and a <span> set
    // to display:block starts a new visual line while its tag says otherwise.
    // Inside the page the computed style is available, so ask it first.
    const isBlock = isBlockLevel(node, tag)
    if (isBlock && parts.length) parts.push('\n')
    for (const child of node.childNodes) walk(child)
    if (isBlock) parts.push('\n')
  }
  walk(el)

  const lines = parts
    .join('')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))

  // Remove the indentation shared by every line.
  //
  // Brototype indents each subtopic by three spaces. Trimming the block as a
  // whole would strip that from the FIRST line only, leaving lines 2..n looking
  // one level deeper — so the parser nested them underneath subtopic 1 and the
  // task reported a single subtopic. Dedenting keeps every line's indent
  // relative to the others, which is what nesting is actually meant to express.
  const indents = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length)
  const common = indents.length ? Math.min(...indents) : 0

  return lines
    .map((line) => (line.trim() ? line.slice(common) : ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/** An element's visible text as trimmed, non-empty lines. */
const textLines = (el) => elementToText(el).split('\n').map((l) => l.trim()).filter(Boolean)

/**
 * Is this element a task heading, as opposed to a block that merely STARTS with
 * a number? A heading is one line. A subtopic list is several — and when
 * Brototype numbers its subtopics ("1. Variables and constants") rather than
 * lettering them, its first line looks exactly like a heading on its own. That
 * is what used to make the whole list get thrown away as if it were the next
 * task, leaving every task with no subtopics.
 */
const looksLikeTaskHeading = (el) => {
  const lines = textLines(el)
  return lines.length === 1 && parseTaskHeading(lines[0]) !== null
}

/**
 * A line that carries its own list marker: "1.", "a)", "-", "•".
 * The space after the marker is optional, matching parse.js — a marker rendered
 * in its own <span> arrives fused to the text as "1.Variables and constants".
 */
const LIST_LINE = /^\s*(?:(?:[0-9]+|[a-zA-Z]{1,3})\s*[.)]\s*(?=\D)|[-*•‣◦]\s+)\S/

/** Card chrome ("Submitted · View Details") is interactive; subtopics are not. */
const INTERACTIVE = 'a,button,input,textarea,select,label'

const isListish = (text) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.some((line) => LIST_LINE.test(line))) return true
  // No markers anywhere: still a list if it is several short lines, which is
  // what a CSS-numbered list looks like as text. A card's status row
  // ("Submitted (8/17/2026) · View Details") is one line, so it stops here.
  return lines.length > 1 && lines.every((line) => line.length <= 120)
}

/**
 * A <ul>/<ol> rendered as text, with a marker added per item.
 *
 * A real list draws "1." with CSS, so the markers are not in the text at all.
 * Without them the parser sees five unmarked lines, treats them as one wrapped
 * sentence and glues them into a single subtopic — five topics becoming one.
 */
function listToText(listEl) {
  const items = [...(listEl.children || [])].filter((c) => c.tagName?.toLowerCase() === 'li')
  if (!items.length) return ''
  const ordered = listEl.tagName.toLowerCase() === 'ol'
  return items
    .map((li, i) => {
      const text = elementToText(li).replace(/\s*\n\s*/g, ' ').trim()
      if (!text) return ''
      return LIST_LINE.test(text) ? text : `${ordered ? `${i + 1}.` : '-'} ${text}`
    })
    .filter(Boolean)
    .join('\n')
}

/** One element's text, reading a real list as a list. */
function candidateText(el) {
  const tag = el.tagName?.toLowerCase()
  if (tag === 'ul' || tag === 'ol') return listToText(el)
  const nested = el.querySelector?.('ul,ol')
  if (nested) return listToText(nested)
  return elementToText(el)
}

/**
 * The subtopic text belonging to one task.
 *
 * Brototype has used several layouts: every subtopic inside one <p> separated
 * by newlines, one <p> or <div> per subtopic, and a real <ol>. So this gathers
 * a RUN of siblings rather than picking a single element, and stops at the
 * first thing that is not list content — which is what keeps the card's
 * "Submitted (8/17/2026) · View Details" row out of the subtopics.
 *
 * `headingEls` is the set of elements already identified as task headings, so
 * the end of this task is known exactly rather than guessed at.
 */
function collectSubtopicText(headingEl, headingEls) {
  const heads = [...headingEls]
  const classify = (el) => {
    if (!el || el.nodeType !== 1) return 'stop'
    // The next task starts here.
    if (headingEls.has(el) || heads.some((h) => h !== headingEl && el.contains?.(h))) return 'stop'
    if (FORM_CONTROL_TAGS.has(el.tagName?.toLowerCase())) return 'skip'
    if (el.querySelector?.(FORM_CONTROLS)) return 'skip'
    const text = candidateText(el)
    if (!text.trim()) return 'skip'
    if (isListish(text)) return text

    // A single line with no marker: one row of a list whose numbers the page
    // drew with CSS, or a piece of card furniture. Only the furniture is
    // interactive, and a list is never one row long — so such lines are taken
    // only as part of a run of at least two (checked by the caller).
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 1 && lines[0].length <= 120 && !el.querySelector?.(INTERACTIVE)) return { weak: text }
    return 'stop'
  }

  const gather = (elements) => {
    const chunks = []
    let weakOnly = true
    for (const el of elements) {
      if (el === headingEl) continue
      const outcome = classify(el)
      if (outcome === 'stop') break
      if (outcome === 'skip') continue
      if (typeof outcome === 'string') { weakOnly = false; chunks.push(outcome) }
      else chunks.push(outcome.weak)
    }
    // One unmarked line on its own is card furniture, not a list.
    if (weakOnly && chunks.length < 2) return []
    return chunks
  }

  // The subtopics sit after the heading, but not always as its siblings: a
  // card may wrap the heading in its own <div>. So try the heading's siblings,
  // then the siblings of each wrapper above it. `classify` still stops at the
  // next task, so climbing cannot wander into the following card.
  for (let node = headingEl, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
    const siblings = []
    for (let el = node.nextElementSibling, i = 0; el && i < 12; el = el.nextElementSibling, i++) siblings.push(el)
    const chunks = gather(siblings)
    if (chunks.length) return chunks.join('\n')
  }

  // Last resort: anything else inside the heading's own parent.
  return gather([...(headingEl.parentElement?.children || [])]).join('\n')
}

/**
 * Collect every element on the page whose own text looks like "N. Something".
 * Then keep only the biggest *consistent* group (same tag name, same depth),
 * which throws away stray matches like a "1. " inside a paragraph of prose.
 */
function findTaskHeadings(root) {
  const candidates = []
  for (const el of root.querySelectorAll(HEADING_CANDIDATES)) {
    const heading = parseTaskHeading(ownText(el))
    if (!heading) continue
    if (el.querySelector(FORM_CONTROLS)) continue
    // Same rule as above: a heading is one line. Without this a numbered
    // subtopic list competes with the real headings for the biggest group, and
    // which one wins comes down to document order.
    if (textLines(el).length > 1) continue
    candidates.push({ el, ...heading, key: `${el.tagName}:${depthOf(el)}` })
  }
  if (!candidates.length) return []

  const groups = new Map()
  for (const c of candidates) {
    if (!groups.has(c.key)) groups.set(c.key, [])
    groups.get(c.key).push(c)
  }

  const all = [...groups.values()]

  // A task's subtopics sit AFTER its heading, as later siblings. So a group
  // whose first member follows a candidate from another group is that other
  // group's subtopic list, not a list of tasks. This is what stops "1.
  // Variables and constants … 5. Template literals" from being read as five
  // tasks — decided by position rather than by which group is bigger, so it
  // holds on a page showing a single task as well as on one showing twelve.
  const elementsOf = (g) => new Set(g.map((c) => c.el))
  const followsAnotherGroup = (group) => {
    const own = elementsOf(group)
    const others = all.filter((g) => g !== group).flatMap((g) => g.map((c) => c.el))
    return group.some((c) => {
      for (let prev = c.el.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (others.includes(prev)) return true
        if (own.has(prev)) return false   // a run of its own kind; keep looking above it
      }
      return false
    })
  }

  const standalone = all.filter((g) => !followsAnotherGroup(g))

  // A task list numbers each task once. Repeats mean one card's subtopics seen
  // across several cards (1..5, 1..5, …).
  const unique = standalone.filter((g) => new Set(g.map((c) => c.number)).size === g.length)
  const usable = unique.length ? unique : standalone.length ? standalone : all

  // A real heading tag beats a <p> or <div>, whatever the counts. The sibling
  // rule above cannot see across subtrees, so a card that wraps its <h4> in its
  // own <div> would otherwise let five subtopic paragraphs outvote one heading.
  const headings = usable.filter((g) => /^H[1-6]$/i.test(g[0].key.split(':')[0]))
  const pool = headings.length ? headings : usable

  // Prefer the group with the most members; break ties by starting at 1.
  return pool.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length
    return (a[0].number === 1 ? -1 : 0) - (b[0].number === 1 ? -1 : 0)
  })[0]
}

function depthOf(el) {
  let d = 0
  for (let p = el.parentElement; p; p = p.parentElement) d++
  return d
}

/** Read the Sem / Paper / Mod chips and the page title. */
function extractUnitInfo(doc, firstHeadingEl) {
  const chip = (name) => doc.querySelector(`[variant="${name}"]`)?.textContent?.trim() || null
  const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ')
  const grab = (re) => (bodyText.match(re) || [])[0]?.trim() || null

  // The chips carry a real `variant` attribute (not a hashed class), so they are
  // the reliable path. The regexes are the safety net if that ever changes.
  const sem = chip('sem') || grab(/\bSem(?:ester)?\s*\d+/i)
  const paper = chip('paper') || grab(/\bPaper\s*\d+/i)
  const mod = chip('module') || grab(/\bMod(?:ule)?\s*\d+/i)
  const week = chip('week') || grab(/\bWeek\s*\d+/i)

  // Title = the nearest real heading above the task list.
  let title = null
  for (let el = firstHeadingEl; el && !title; el = el.parentElement) {
    for (const h of el.querySelectorAll?.('h1,h2') || []) {
      const text = ownText(h)
      if (text && !parseTaskHeading(text)) { title = text; break }
    }
  }
  title = title || doc.querySelector('h1,h2')?.textContent?.trim() || doc.title?.trim() || 'Brototype Tasks'

  const status = doc.querySelector('[status]')?.getAttribute('status') || null
  const type = doc.querySelector('span[type]')?.textContent?.trim() || null

  return { title, sem, paper, module: mod, week, status, type }
}

/**
 * Notion page title. Prefers the most specific identifier available so that
 * pages sort sensibly and never collide: "Mod 6 - React - Advanced Concepts".
 */
export function buildPageTitle(unit) {
  const prefix = unit.week || unit.module || unit.paper || null
  return prefix ? `${prefix} — ${unit.title}` : unit.title
}

/**
 * Main entry point. Returns the normalised structure the rest of the app uses.
 * `savedSelector` (optional) narrows the search to a container you picked by
 * hand last time - see picker.js.
 */
export function extractFromDocument(doc, savedSelector = null) {
  const warnings = []
  let root = doc

  if (savedSelector) {
    const saved = doc.querySelector(savedSelector)
    if (saved) root = saved
    else warnings.push('Your saved task-list location no longer exists on this page, so the whole page was scanned instead.')
  }

  let headings = findTaskHeadings(root)
  if (!headings.length && root !== doc) {
    headings = findTaskHeadings(doc)
    if (headings.length) warnings.push('Tasks were found outside your saved task-list location.')
  }

  if (!headings.length) {
    return { ok: false, source: savedSelector ? 'selector' : 'scan', unit: null, tasks: [], warnings, reason: 'no-tasks' }
  }

  headings.sort((a, b) => a.number - b.number)

  const headingEls = new Set(headings.map((h) => h.el))
  const tasks = headings.map(({ el, number, title }) => {
    const raw = collectSubtopicText(el, headingEls)
    return { number, title, subtopics: parseSubtopics(raw), raw }
  })

  const empty = tasks.filter((t) => t.subtopics.length === 0)
  if (empty.length) {
    warnings.push(`${empty.length} task(s) had no subtopics detected: ${empty.map((t) => t.number).join(', ')}. You can still generate notes for them from the title alone.`)
  }

  const expected = tasks.map((_, i) => i + 1).join(',')
  if (tasks.map((t) => t.number).join(',') !== expected) {
    warnings.push(`Task numbers are not a clean 1..${tasks.length} sequence — check nothing was missed.`)
  }

  const unit = extractUnitInfo(doc, headings[0].el)

  return {
    ok: true,
    source: savedSelector && root !== doc ? 'selector' : 'scan',
    unit,
    pageTitle: buildPageTitle(unit),
    tasks,
    warnings,
  }
}

export { elementToText, ownText }
