/**
 * content.js - strips the structure a model tried to smuggle INTO the content.
 *
 * The application owns the Notion structure: headings, levels, order, toggles.
 * But a model - especially one reached through OpenRouter without strict
 * schema support - will happily write its own structure inside a field:
 *
 *   "## What is it?\nuseContext is..."       a markdown heading
 *   "**Remember:** dispatch → reducer"        a label duplicating our heading
 *   "- first point\n- second point"           a bulleted list inside a prose field
 *   "```jsx\nconst v = useContext(C)\n```"    a fenced code block
 *   "1. a\n2. b"  where an array was expected
 *
 * Left alone, each of those renders differently in Notion, so two models give
 * two layouts. These cleaners run on EVERY response, whichever provider, so the
 * only structure that reaches Notion is the one blocks.js builds.
 *
 * They are deliberately conservative: they remove markup, never words.
 */

const FENCE = /^\s*```[\w+-]*\s*\n([\s\S]*?)\n?\s*```\s*$/
const FENCE_LANG = /^\s*```([\w+-]+)/

/** "```jsx\ncode\n```" -> { code: "code", language: "jsx" }. Unfenced text passes through. */
export function stripFences(text) {
  const source = String(text ?? '')
  const match = source.match(FENCE)
  if (!match) return { code: source.trim(), language: '' }
  return { code: match[1].trim(), language: (source.match(FENCE_LANG) || [])[1] || '' }
}

// Labels a model might prepend to a field, duplicating the heading Notion adds.
const LABEL_WORDS = [
  'what problem does it solve', 'problem', 'what is it', 'definition', 'simple meaning', 'meaning',
  'why does it exist', 'why', 'how does it work', 'how it works', 'flow',
  'important things to understand', 'important', 'key concepts', 'key points',
  'real-world example', 'real world example', 'real-life example', 'example', 'use case',
  'basic syntax', 'syntax', 'simple example', 'code example', 'code', 'step by step', 'steps', 'explanation',
  'complete working code', 'complete code', 'full code', 'common mistakes', 'mistakes',
  'when to use it', 'when to use', 'when not to use it', 'when not to use', 'remember', 'summary',
  'analogy', 'beginner tips', 'tips', 'related concepts', 'related', 'practical scenario', 'scenario',
  'answer', 'question',
]
const LEADING_LABEL = new RegExp(
  // The separator may sit inside or outside the bold: "**Label:** x" and "**Label**: x".
  `^\\s*(?:[#>*_-]+\\s*)?(?:\\*\\*|__)?\\s*(?:${LABEL_WORDS.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\s*\\??(?:\\s*(?:\\*\\*|__))?\\s*[:\\-–—](?:\\s*(?:\\*\\*|__))?\\s*`,
  'i',
)

// A whole line that is nothing but one of our labels, e.g. "## What is it?" or "**Remember**".
const STANDALONE_LABEL = new RegExp(
  `^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(?:${LABEL_WORDS.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\s*\\??\\s*(?:\\*\\*|__)?\\s*:?\\s*$`,
  'i',
)

const MD_HEADING = /^\s{0,3}#{1,6}\s+/
const BULLET = /^\s*(?:[-*+•‣◦]|\d{1,3}[.)]|[a-z][.)]|[ivx]{1,4}[.)])\s+/i

/** One line: drop heading marks, list marks, and a label that duplicates our heading. */
function cleanLine(line) {
  const unheaded = line.replace(MD_HEADING, '')
  const unlabelled = unheaded.replace(LEADING_LABEL, '')
  return (unlabelled.trim() ? unlabelled : unheaded).trimEnd()
}

/**
 * Prose field. Removes headings and leading labels; keeps line breaks and
 * inline **bold** / `code`, which richText() renders. Bulleted lines inside
 * prose stay as lines (their marker removed) rather than becoming blocks.
 */
export function cleanProse(value) {
  const { code, language } = stripFences(value)
  // A prose field that arrived fenced was mislabelled code, not prose; keep the text.
  const text = language ? code : String(value ?? '')
  const lines = text.split('\n')
  // A model that wrote our heading as its own first line: drop that line.
  while (lines.length > 1 && STANDALONE_LABEL.test(lines[0])) lines.shift()
  return lines
    .map((line, i) => (i === 0 ? cleanLine(line) : line.replace(MD_HEADING, '').replace(BULLET, '').trimEnd()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * List field. Accepts an array (items may carry their own markers) or a
 * string (split on lines / markers). Objects are flattened to their first
 * string value. Empty items are dropped.
 */
export function cleanList(value) {
  let items
  if (Array.isArray(value)) {
    items = value.flatMap((v) => {
      if (v && typeof v === 'object') {
        const first = Object.values(v).find((x) => typeof x === 'string' && x.trim())
        return first ? [first] : []
      }
      return [String(v ?? '')]
    })
  } else {
    const text = cleanProse(value)
    items = text.split('\n')
  }
  return items
    .flatMap((item) => String(item).split('\n'))
    .map((item) => cleanLine(item).replace(BULLET, '').trim())
    .filter(Boolean)
}

/** Code field. Fences removed, prose label removed, language recovered from the fence. */
export function cleanCode(value) {
  const { code, language } = stripFences(String(value ?? '').replace(LEADING_LABEL, ''))
  return { code, language }
}

/**
 * "Q1. Why…" / "Question 1: Why…" / "A: Because…" -> the bare text.
 * Never strips to nothing: if removing the "label" leaves no text, it was
 * not a label but the content itself.
 */
export function cleanQuestionText(value) {
  const source = String(value ?? '')
  const stripped = source.replace(/^\s*(?:q(?:uestion)?|a(?:nswer)?)\s*\d*\s*[.:)-]\s*/i, '')
  return cleanProse(stripped.trim() ? stripped : source)
}

/**
 * A heading the AI chose. Lighter than cleanProse: only markup comes off -
 * "## **What is useContext?**:" -> "What is useContext?" - and it is kept
 * to one short line so a paragraph cannot masquerade as a heading.
 */
export function cleanHeading(value) {
  return String(value ?? '')
    .split('\n')[0]
    .replace(MD_HEADING, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim()
    .slice(0, 80)
}

/**
 * Remove a label that duplicates THIS section's own heading, e.g. the text
 * "**What is useContext?:** Lets a component…" under the heading
 * "What is useContext?". Headings are chosen by the AI, so they cannot be in
 * LABEL_WORDS - the heading itself is the label to look for.
 */
export function stripOwnHeading(text, heading) {
  const source = String(text ?? '')
  const label = String(heading ?? '').trim()
  if (!label) return source
  const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const pattern = new RegExp(`^\\s*(?:\\*\\*|__)?\\s*${escaped}\\s*(?:\\*\\*|__)?\\s*[:\\-–—]?\\s*(?:\\*\\*|__)?\\s*`, 'i')
  const stripped = source.replace(pattern, '')
  return stripped.trim() ? stripped : source
}

/**
 * Remove a list marker a model (or a source page) put in front of a title:
 * "a. Local state" / "2) Context API" / "iii. Reviews" -> the bare title.
 * The writer adds numbering exactly once, so titles must arrive without it.
 */
export const stripListMarker = (value) =>
  String(value ?? '').replace(/^\s*(?:[a-z]{1,2}|\d{1,3}|[ivx]{1,5})\s*[.)]\s+/i, '').trim()
