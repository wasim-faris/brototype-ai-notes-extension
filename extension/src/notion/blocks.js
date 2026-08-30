/**
 * blocks.js - turns validated study notes into real Notion blocks.
 *
 * This file is PURE (structured data in, JSON out), so it is fully unit-tested.
 * It is also where all of Notion's awkward limits are handled in one place:
 *
 *   - a single rich-text object may hold at most 2000 characters
 *   - a rich-text array may hold at most 100 objects
 *   - a code block needs a language from Notion's own list, not any string
 *
 * The layout it produces is the one you asked for: main task is a collapsed
 * toggle heading, each subtopic is a toggle inside it, and the reviewer
 * questions are a toggle of toggles at the end.
 */

const TEXT_LIMIT = 2000

// Notion only accepts languages from its own list; anything else is a 400.
const LANGUAGE_MAP = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'shell', zsh: 'shell', console: 'shell', terminal: 'shell',
  html: 'html', css: 'css', json: 'json', sql: 'sql', yml: 'yaml', yaml: 'yaml',
  java: 'java', go: 'go', rust: 'rust', php: 'php', ruby: 'ruby', c: 'c',
  'c++': 'c++', cpp: 'c++', csharp: 'c#', 'c#': 'c#', bash: 'bash', shell: 'shell',
  javascript: 'javascript', typescript: 'typescript', python: 'python',
}
const notionLanguage = (raw) => LANGUAGE_MAP[String(raw || '').toLowerCase().trim()] || 'plain text'

/** Split a long string on a word boundary so no chunk exceeds Notion's limit. */
function chunkText(text, limit = TEXT_LIMIT) {
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * Convert light markdown (**bold** and `code`) into Notion rich text.
 * The AI is told to use only these two, so a full markdown parser is overkill.
 */
export function richText(text) {
  const source = String(text ?? '').trim()
  if (!source) return []

  const out = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let cursor = 0

  const push = (content, annotations) => {
    if (!content) return
    for (const chunk of chunkText(content)) {
      if (out.length >= 100) return
      out.push({ type: 'text', text: { content: chunk }, ...(annotations ? { annotations } : {}) })
    }
  }

  for (const match of source.matchAll(pattern)) {
    push(source.slice(cursor, match.index))
    const token = match[0]
    if (token.startsWith('**')) push(token.slice(2, -2), { bold: true })
    else push(token.slice(1, -1), { code: true })
    cursor = match.index + token.length
  }
  push(source.slice(cursor))

  return out
}

// --- Block constructors ---------------------------------------------------

const block = (type, value) => ({ object: 'block', type, [type]: value })

export const paragraph = (text) => block('paragraph', { rich_text: richText(text) })
export const heading3 = (text) => block('heading_3', { rich_text: richText(text) })
export const bullet = (text) => block('bulleted_list_item', { rich_text: richText(text) })
export const numbered = (text) => block('numbered_list_item', { rich_text: richText(text) })
export const divider = () => block('divider', {})

export const callout = (text, emoji = '💡', color = 'gray_background') =>
  block('callout', { rich_text: richText(text), icon: { type: 'emoji', emoji }, color })

export const code = (content, language) =>
  block('code', {
    // Code is verbatim: no markdown parsing, just length chunking.
    rich_text: chunkText(String(content ?? '')).map((c) => ({ type: 'text', text: { content: c } })),
    language: notionLanguage(language),
  })

/**
 * A small comparison table. Notion needs the rows as children of the table
 * block in the same request; every row must have exactly table_width cells.
 */
export const table = (headers = [], rows = []) => {
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 1)
  const row = (cells) => ({
    object: 'block',
    type: 'table_row',
    table_row: { cells: Array.from({ length: width }, (_, i) => richText(cells[i] ?? '')) },
  })
  return block('table', {
    table_width: width,
    has_column_header: headers.length > 0,
    has_row_header: false,
    children: [...(headers.length ? [row(headers)] : []), ...rows.map(row)],
  })
}

export const toggle = (text, children = []) =>
  block('toggle', { rich_text: richText(text), children })

/** A heading that collapses. This is what makes the main page stay clean. */
export const toggleHeading = (text, children = [], level = 2) =>
  block(`heading_${level}`, { rich_text: richText(text), is_toggleable: true, children })

// --- Note layout ----------------------------------------------------------

// --- The fixed hierarchy ----------------------------------------------------
//
//   buildMainTopicBlock      ▸ 1. Main topic          toggle H1
//     buildSubtopicToggle      ▸ a. Subtopic            toggle H2
//       buildSectionHeading      <heading the AI chose>   H3
//       buildSectionContent      paragraphs | bullets | numbered | code | table
//
// Levels, labels, nesting and block types are decided HERE. The AI decides
// only which sections a topic needs, their headings, and their words.

import { LEGACY_SECTIONS } from '../ai/schema.js'
import { stripListMarker } from '../ai/content.js'

export const buildSectionHeading = (heading) => heading3(heading)

/** The blocks under one section heading, by the section's kind. Empty content -> no blocks. */
export function buildSectionContent(section) {
  switch (section.kind) {
    case 'text':
      return section.text ? chunkText(section.text, 1800).map(paragraph) : []
    case 'list':
      return section.items?.length ? section.items.map(bullet) : []
    case 'steps':
      return section.items?.length ? section.items.map(numbered) : []
    case 'code':
      return section.code ? [code(section.code, section.language)] : []
    case 'table':
      return section.rows?.length ? [table(section.headers, section.rows)] : []
    default:
      return []
  }
}

/** One section: its H3 plus its content, or nothing at all if the content is empty. */
function buildSection(section) {
  const content = buildSectionContent(section)
  return content.length ? [buildSectionHeading(section.heading), ...content] : []
}

/** A topic that still carries the old flat fields, e.g. from a test fixture. */
function legacyTopicSections(topic) {
  return LEGACY_SECTIONS.flatMap(({ field, heading, kind }) => {
    const value = topic[field]
    if (!value || (Array.isArray(value) && !value.length)) return []
    if (kind === 'code') return [{ heading, kind, code: value, language: topic.codeLanguage }]
    if (kind === 'text') return [{ heading, kind, text: value }]
    return [{ heading, kind, items: Array.isArray(value) ? value : [value] }]
  })
}

/** Everything inside one subtopic: the AI's sections, in the AI's order, each as H3 + content. */
export const buildTopicBlocks = (topic) =>
  (Array.isArray(topic.sections) ? topic.sections : legacyTopicSections(topic)).flatMap(buildSection)

/** ▸ a. Subtopic - a toggle H2 whose children are the subtopic's sections. */
export const buildSubtopicToggle = (topic, index) =>
  // Numbering is applied exactly HERE, once. A title that already carries a
  // marker ("a. Local state") loses it first, so "a. a. …" cannot be written.
  toggleHeading(`${subtopicLetter(index)}. ${stripListMarker(topic.title)}`, buildTopicBlocks(topic), 2)

/** ▸ 1. Main topic - a toggle H1. `children` are appended separately by pages.js. */
export const buildMainTopicBlock = (notes, children = []) =>
  toggleHeading(`${notes.number}. ${stripListMarker(notes.title)}`, children, 1)

/**
 * The complete tree for one task: main topic -> subtopics -> sections.
 * Built in one place so tests can assert on the whole hierarchy. pages.js
 * writes it in layers because Notion accepts two nesting levels per request.
 */
export function buildTaskTree(notes) {
  const { blocks } = buildTaskSections(notes).reduce((acc, s) => ({ blocks: [...acc.blocks, ...s.blocks] }), { blocks: [] })
  return buildMainTopicBlock(notes, blocks)
}

/** 0 -> "a", 25 -> "z", 26 -> "aa". Matches how Brototype letters its subtopics. */
export function subtopicLetter(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** The "🧠 Reviewer Questions" toggle: 5 question toggles, each hiding its answer. */
export function buildQuestionsBlock(reviewQuestions) {
  if (!reviewQuestions?.length) return null
  return toggle(
    '🧠 Reviewer Questions',
    reviewQuestions.map((q, i) =>
      toggle(`Q${i + 1}. ${q.question}`, chunkText(q.answer, 1800).map(paragraph)),
    ),
  )
}

/**
 * Everything that goes INSIDE one main-task toggle.
 * Returned as separate pieces so pages.js can append them one at a time and
 * report progress ("Creating useContext...") as it goes.
 */
export function buildTaskSections(notes) {
  const sections = []
  if (notes.summary) sections.push({ label: 'summary', blocks: [callout(notes.summary, '📌', 'gray_background')] })

  notes.topics.forEach((topic, index) => {
    const block = buildSubtopicToggle(topic, index)
    sections.push({ label: block.heading_2.rich_text[0].text.content, blocks: [block] })
  })

  const questions = buildQuestionsBlock(notes.reviewQuestions)
  if (questions) sections.push({ label: 'Reviewer Questions', blocks: [questions] })

  return sections
}

/** The header that sits at the top of the generated page. */
export function buildPageHeader(unit, { taskCount, generatedAt = new Date() } = {}) {
  const chips = [unit?.sem, unit?.paper, unit?.module, unit?.type].filter(Boolean).join(' · ')
  const stamp = generatedAt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  return [
    callout(
      `${chips ? `${chips}\n` : ''}${taskCount} task${taskCount === 1 ? '' : 's'} · notes generated ${stamp}`,
      '📚',
      'blue_background',
    ),
    paragraph('Open a task below to study it. Each subtopic is a separate dropdown, and every task ends with 5 reviewer questions.'),
    divider(),
  ]
}

export { chunkText, notionLanguage }
