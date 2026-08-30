/**
 * parse.js - turns Brototype's task TEXT into a clean nested structure.
 *
 * Why this file exists separately from extractor.js:
 * extractor.js touches the DOM (so it can only run inside a browser page).
 * This file is pure text -> object, so it can be unit-tested with plain Node.
 * That matters because THIS is the logic most likely to need tweaking when
 * Brototype changes how they write their task lists.
 *
 * The hard part it solves: Brototype writes subtopics inside ONE <p> tag as
 * plain newline-separated text, and mixes two kinds of markers:
 *
 *   a. Use AI For          <- letter marker,  level 1
 *    i. Architecture reviews  <- roman marker, level 2  (indented)
 *
 * ...while another task legitimately runs a. b. c. ... h. i. j.
 * where "i." is the 9th LETTER, not roman numeral one. See classifyLine().
 */

const ROMAN = /^(x{0,3})(ix|iv|v?i{0,3})$/i
const AMBIGUOUS = new Set(['i', 'v', 'x']) // valid as both a letter and a roman numeral

/** Split "a. useContext" into its marker and its text. */
function splitMarker(line) {
  // The space after the marker is optional: a framework that renders the
  // number in its own <span> leaves no whitespace between the elements, so the
  // line arrives as "1.Variables and constants". The lookahead keeps a decimal
  // like "1.5 million users" from being read as marker 1, text "5 million".
  const m = line.match(/^\s*([0-9]+|[a-zA-Z]+)\s*[.)]\s*(?=\D)(.*)$/)
  if (m && m[2].trim()) return { marker: m[1], text: m[2].trim() }

  const bullet = line.match(/^\s*[-*•‣◦]\s+(.*)$/)
  if (bullet) return { marker: null, text: bullet[1], bullet: true }

  return { marker: null, text: line.trim() }
}

/**
 * Decide what kind of list item a line is.
 * `state.expectedLetter` is the letter we would expect next if the current run
 * is a plain a/b/c list - that is what lets us tell "i." the 9th letter apart
 * from "i." the roman numeral.
 */
function classifyLine(rawLine, state) {
  const indent = rawLine.length - rawLine.trimStart().length
  const { marker, text, bullet } = splitMarker(rawLine)

  if (!text) return null
  if (bullet) return { type: 'bullet', marker: null, text, indent }
  if (!marker) return { type: 'plain', marker: null, text, indent }

  if (/^[0-9]+$/.test(marker)) {
    return { type: 'number', marker, text, indent, number: Number(marker) }
  }

  const lower = marker.toLowerCase()
  const isSingleLetter = lower.length === 1

  // Unambiguous roman numeral, e.g. "ii." / "iv." - never a single letter list.
  if (!isSingleLetter && ROMAN.test(lower)) {
    return { type: 'roman', marker: lower, text, indent }
  }

  if (isSingleLetter) {
    // "i." / "v." / "x." are the ambiguous cases. Treat as a LETTER only when
    // it continues the letter run we are already in at the same indent level.
    if (AMBIGUOUS.has(lower)) {
      const continuesLetterRun = lower === state.expectedLetter && indent <= state.letterIndent
      return continuesLetterRun
        ? { type: 'letter', marker: lower, text, indent }
        : { type: 'roman', marker: lower, text, indent }
    }
    return { type: 'letter', marker: lower, text, indent }
  }

  return { type: 'plain', marker: null, text: `${marker}. ${text}`, indent }
}

function nextLetter(letter) {
  return letter >= 'z' ? 'z' : String.fromCharCode(letter.charCodeAt(0) + 1)
}

/**
 * Parse the newline-separated subtopic blob of ONE task.
 * Returns [{ title, children: [{ title, children: [] }] }]
 */
/**
 * Put a line break before a marker that is glued to the end of the previous
 * item: "…and constants2. Scope and execution flow3. Primitive…".
 *
 * This happens when the page separates subtopics with elements the browser
 * lays out as blocks but whose tags are inline (a <span> with display:block,
 * which is ordinary for styled-components). The text then arrives as one line
 * and the whole list reads as a single subtopic.
 *
 * Two things keep this from firing on ordinary text. The marker must be glued
 * to a non-space character, so "see step 2. do this" mid-sentence is left
 * alone; and only DIGITS count, so a roman numeral run (i. ii. iii.) cannot be
 * cut in half — "ii." would otherwise split into "…i" and "i.".
 */
const splitGluedMarkers = (text) =>
  text.replace(/(\S)(?=\d{1,2}[.)]\s+\S)/g, '$1\n')

export function parseSubtopics(blob) {
  if (!blob || !blob.trim()) return []

  const state = { expectedLetter: 'a', letterIndent: 0 }
  const items = []

  for (const rawLine of splitGluedMarkers(blob).split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const item = classifyLine(rawLine, state)
    if (!item) continue

    if (item.type === 'letter') {
      state.expectedLetter = nextLetter(item.marker)
      state.letterIndent = Math.max(state.letterIndent, item.indent)
    }
    items.push(item)
  }

  return buildTree(items)
}

/**
 * Turn a flat list of classified lines into a 2-level tree.
 * Indentation wins when it is present; marker type is the fallback, so a task
 * whose nesting is expressed only by "a." vs "i." still nests correctly.
 */
function buildTree(items) {
  const baseIndent = Math.min(...items.map((i) => i.indent))
  const roots = []

  // If not one line carries a marker, the page drew them with CSS (an <ol>, or
  // a counter on each row). They are separate items, so gluing them onto each
  // other would collapse the whole list into a single subtopic.
  const noneMarked = items.every((item) => item.type === 'plain')

  for (const item of items) {
    const nestedByIndent = item.indent > baseIndent
    const nestedByType = item.type === 'roman'
    const isChild = (nestedByIndent || nestedByType) && roots.length > 0

    if (item.type === 'plain' && roots.length > 0 && !noneMarked) {
      // A wrapped line with no marker of its own: glue it back onto the item above.
      const parent = isChild && last(roots).children.length ? last(last(roots).children) : last(roots)
      parent.title = `${parent.title} ${item.text}`.trim()
      continue
    }

    const node = { title: item.text.trim(), children: [] }
    if (isChild) last(roots).children.push(node)
    else roots.push(node)
  }

  return roots
}

const last = (arr) => arr[arr.length - 1]

/** "1. Understand Advanced React Hooks" -> { number: 1, title: "Understand ..." } */
export function parseTaskHeading(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  const m = clean.match(/^(\d+)\s*[.):-]\s*(.+)$/)
  if (!m) return null
  const title = m[2].trim()
  if (!title) return null
  return { number: Number(m[1]), title }
}

/**
 * Fallback path: parse a whole task list pasted as plain text.
 * Used when DOM detection fails entirely, so you are never blocked.
 */
export function parseTaskListText(text) {
  const tasks = []
  let buffer = []

  const flush = () => {
    if (!tasks.length) return
    last(tasks).subtopics = parseSubtopics(buffer.join('\n'))
    buffer = []
  }

  for (const rawLine of (text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const heading = parseTaskHeading(rawLine)
    // A numbered line only starts a NEW task when it is not indented under one.
    const indent = rawLine.length - rawLine.trimStart().length
    if (heading && indent === 0) {
      flush()
      tasks.push({ number: heading.number, title: heading.title, subtopics: [] })
    } else {
      buffer.push(rawLine)
    }
  }
  flush()

  return tasks
}
