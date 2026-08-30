/**
 * The contract between ANY AI provider and the Notion builder.
 *
 * The AI decides WHICH sections a subtopic needs - a simple theory topic may
 * need one, a hook may need six - and writes their content. The application
 * decides everything else: the hierarchy (main topic > subtopic > section),
 * the block types, the cleaning, the caps. See blocks.js.
 *
 * Written in plain JSON Schema; each adapter translates it into its provider's
 * dialect with the converters at the bottom.
 *
 * Nothing reaches Notion without passing through normaliseTask(), whichever
 * provider produced it.
 */

import { cleanProse, cleanList, cleanCode, cleanHeading, cleanQuestionText, stripOwnHeading, stripListMarker } from './content.js'

const str = (description) => ({ type: 'string', description })
const list = (description) => ({ type: 'array', items: { type: 'string' }, description })

/** The kinds of content a section can hold. The only structure the AI chooses. */
export const SECTION_KINDS = ['text', 'list', 'code', 'table']

/** A single section: one heading, one kind of content. The unused content fields stay empty. */
const SECTION_SCHEMA = {
  type: 'object',
  properties: {
    heading: str('A short heading for this section, in plain words. E.g. "What is useContext?", "Real-world example", "useState vs useContext", "Simple example".'),
    kind: { type: 'string', enum: SECTION_KINDS, description: 'What this section contains: "text" (a few short sentences), "list" (short bullet points), "code" (code only), or "table" (a small comparison).' },
    text: str('For kind "text": a few short sentences or short lines (up to about six when a small scene makes an example easier to picture). Empty string for other kinds.'),
    items: list('For kind "list": short bullet points, one idea each. Empty list for other kinds.'),
    code: str('For kind "code": the code only - no prose, no markdown fences. Empty string for other kinds.'),
    language: str('For kind "code": the language, e.g. "jsx", "javascript", "bash". Empty string for other kinds.'),
    tableHeaders: list('For kind "table": the column headers. Empty list for other kinds.'),
    tableRows: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
      description: 'For kind "table": one array per row, one string per cell, matching the headers. Empty list for other kinds.',
    },
  },
  required: ['heading', 'kind', 'text', 'items', 'code', 'language', 'tableHeaders', 'tableRows'],
}

/** Hard cap so a verbose model cannot turn one subtopic into a chapter. */
export const MAX_SECTIONS_PER_TOPIC = 8

const TOPIC_SCHEMA = {
  type: 'object',
  properties: {
    title: str('The subtopic name exactly as it appeared in the Brototype task.'),
    sections: {
      type: 'array',
      maxItems: MAX_SECTIONS_PER_TOPIC,
      description: 'ONLY the sections needed to understand this specific topic, in learning order. One or two for a simple theory topic; more for a concept with code. Never pad.',
      items: SECTION_SCHEMA,
    },
  },
  required: ['title', 'sections'],
}

export const TASK_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'integer', description: 'The Brototype task number.' },
    title: str('The Brototype task title.'),
    summary: str('One or two sentences: what this whole task is about. Empty string if the title already says it.'),
    topics: { type: 'array', items: TOPIC_SCHEMA, description: 'One entry per subtopic, in the original order.' },
    reviewQuestions: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      description: 'Exactly 5 questions a Brototype reviewer could realistically ask, testing understanding rather than memorisation.',
      items: {
        type: 'object',
        properties: {
          question: str('The question, phrased the way a technical reviewer would say it out loud.'),
          answer: str('A short, complete answer the student could actually say in a review.'),
        },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['number', 'title', 'summary', 'topics', 'reviewQuestions'],
}

/** Schema for a single topic, used when a task is too big for one request. */
export const TOPIC_ONLY_SCHEMA = TOPIC_SCHEMA

/** Used when a task had to be split: questions are generated on their own. */
export const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: { reviewQuestions: TASK_SCHEMA.properties.reviewQuestions },
  required: ['reviewQuestions'],
}

/**
 * The OLD contract - one fixed field per section - kept only so a response in
 * that shape (an older model prompt, a cached backend) still renders. Each
 * legacy field becomes a section with this heading and kind.
 */
export const LEGACY_SECTIONS = Object.freeze([
  { field: 'simpleExplanation', heading: 'In short', kind: 'text' },
  { field: 'problemSolved', heading: 'What problem does it solve?', kind: 'text' },
  { field: 'whatIsIt', heading: 'What is it?', kind: 'text' },
  { field: 'whyItExists', heading: 'Why does it exist?', kind: 'text' },
  { field: 'howItWorks', heading: 'How does it work?', kind: 'text' },
  { field: 'keyConcepts', heading: 'Important things to understand', kind: 'list' },
  { field: 'realProjectExample', heading: 'Real-world example', kind: 'text' },
  { field: 'syntax', heading: 'Basic syntax', kind: 'code' },
  { field: 'codeExample', heading: 'Simple example', kind: 'code' },
  { field: 'codeExplanation', heading: 'Step by step', kind: 'steps' },
  { field: 'completeCode', heading: 'Complete working code', kind: 'code' },
  { field: 'commonMistakes', heading: 'Common mistakes', kind: 'list' },
  { field: 'whenToUse', heading: 'When to use it', kind: 'list' },
  { field: 'whenNotToUse', heading: 'When NOT to use it', kind: 'list' },
  { field: 'importantPoints', heading: 'Remember', kind: 'list' },
  { field: 'realLifeAnalogy', heading: 'Analogy', kind: 'text' },
  { field: 'beginnerTips', heading: 'Beginner tips', kind: 'list' },
  { field: 'relatedConcepts', heading: 'Related concepts', kind: 'list' },
  { field: 'practicalScenario', heading: 'Practical scenario', kind: 'text' },
])

// --- dialect converters ---------------------------------------------------

/** Gemini wants an OpenAPI-flavoured schema: UPPERCASE types and explicit property ordering. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema

  const out = {}
  if (schema.type) out.type = String(schema.type).toUpperCase()
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (typeof schema.minItems === 'number') out.minItems = schema.minItems
  if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems
  if (schema.items) out.items = toGeminiSchema(schema.items)

  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    )
    out.propertyOrdering = Object.keys(schema.properties)
  }
  if (schema.required) out.required = schema.required

  return out
}

/**
 * OpenAI (and Grok) strict `json_schema` mode is a RESTRICTED subset:
 * every object sets additionalProperties:false, every property is required,
 * and array length keywords are rejected. Dropped limits are still stated in
 * the descriptions and enforced afterwards by normaliseTask().
 */
export function toStrictJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema

  const { minItems, maxItems, ...rest } = schema
  const out = { ...rest }

  if (out.items) out.items = toStrictJsonSchema(out.items)
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, toStrictJsonSchema(value)]),
    )
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  return out
}

/** Last-resort mechanism for a server that enforces nothing: describe the shape in the prompt. */
export function schemaToPromptText(schema) {
  return `Reply with ONLY a JSON object, no prose and no markdown fences, matching this JSON Schema exactly:\n\n${JSON.stringify(schema, null, 1)}`
}

// --- normalisation ---------------------------------------------------------

const asString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v))
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '')

/** Names a model might use for each legacy field, matched on lower-case alphanumerics. */
const LEGACY_ALIASES = {
  simpleExplanation: ['simpleexplanation', 'summary', 'simplemeaning', 'meaning', 'inshort', 'tldr', 'overview'],
  problemSolved: ['problemsolved', 'problem', 'whatproblemdoesitsolve', 'problemitsolves'],
  whatIsIt: ['whatisit', 'whatis', 'definition', 'what'],
  whyItExists: ['whyitexists', 'why', 'whyweneedit', 'whydoesitexist'],
  howItWorks: ['howitworks', 'how', 'howdoesitwork', 'flow', 'working'],
  keyConcepts: ['keyconcepts', 'important', 'importantthings', 'importantthingstounderstand', 'keypoints', 'concepts'],
  realProjectExample: ['realprojectexample', 'realworldexample', 'realworld', 'reallifeexample', 'usecase', 'example'],
  syntax: ['syntax', 'basicsyntax', 'signature', 'api'],
  codeLanguage: ['codelanguage', 'language', 'lang'],
  codeExample: ['codeexample', 'simpleexample', 'smallexample', 'examplecode', 'code', 'basicexample'],
  codeExplanation: ['codeexplanation', 'stepbystep', 'steps', 'explanation', 'walkthrough'],
  completeCode: ['completecode', 'completeworkingcode', 'fullcode', 'completeexample', 'fullexample', 'workingcode'],
  commonMistakes: ['commonmistakes', 'mistakes', 'pitfalls', 'gotchas'],
  whenToUse: ['whentouse', 'whentouseit', 'usewhen'],
  whenNotToUse: ['whennottouse', 'whennottouseit', 'avoidwhen', 'whennot', 'dontusewhen'],
  importantPoints: ['importantpoints', 'remember', 'importantpointstoremember', 'takeaways', 'keytakeaways'],
  realLifeAnalogy: ['reallifeanalogy', 'analogy'],
  beginnerTips: ['beginnertips', 'tips'],
  relatedConcepts: ['relatedconcepts', 'related', 'seealso'],
  practicalScenario: ['practicalscenario', 'scenario'],
}
const ALIAS_TO_LEGACY = new Map()
for (const [field, aliases] of Object.entries(LEGACY_ALIASES)) for (const a of aliases) ALIAS_TO_LEGACY.set(a, field)

const KIND_ALIASES = {
  text: ['text', 'paragraph', 'prose', 'explanation', 'note', 'notes', 'description'],
  list: ['list', 'bullets', 'bullet', 'points', 'bulletlist', 'items', 'tips'],
  steps: ['steps', 'step', 'stepbystep', 'numbered', 'orderedlist'],
  code: ['code', 'snippet', 'example', 'codeexample', 'syntax'],
  table: ['table', 'comparison', 'compare', 'grid'],
}
const ALIAS_TO_KIND = new Map()
for (const [kind, aliases] of Object.entries(KIND_ALIASES)) for (const a of aliases) ALIAS_TO_KIND.set(a, kind)

const pick = (obj, ...names) => {
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n]
  return undefined
}

/** A table row may arrive as an array of cells, a "a | b | c" string, or an object. */
function cleanRows(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((row) => {
      if (Array.isArray(row)) return row.map((c) => cleanProse(c))
      if (row && typeof row === 'object') return Object.values(row).map((c) => cleanProse(c))
      return String(row ?? '').split('|').map((c) => cleanProse(c))
    })
    .filter((cells) => cells.some(Boolean))
}

/**
 * Normalise ONE section into { heading, kind, text | items | code+language | headers+rows }.
 * Unknown kinds become the kind the content implies. Empty sections return null.
 */
export function normaliseSection(raw) {
  if (!raw || typeof raw !== 'object') return null
  const heading = cleanHeading(pick(raw, 'heading', 'title', 'name', 'label'))

  const text = cleanProse(stripOwnHeading(pick(raw, 'text', 'content', 'body', 'paragraph', 'explanation'), heading))
  const items = cleanList(pick(raw, 'items', 'points', 'bullets', 'list'))
  const { code, language: fenced } = cleanCode(pick(raw, 'code', 'snippet'))
  const language = asString(pick(raw, 'language', 'lang', 'codeLanguage')) || fenced
  const headers = cleanList(pick(raw, 'tableHeaders', 'headers', 'columns'))
  const rows = cleanRows(pick(raw, 'tableRows', 'rows'))

  let kind = ALIAS_TO_KIND.get(normKey(pick(raw, 'kind', 'type') ?? '')) || ''
  // Trust the content over the label: a "text" section carrying only code is code.
  if (kind === 'table' && !rows.length) kind = ''
  if (kind === 'code' && !code) kind = ''
  if ((kind === 'list' || kind === 'steps') && !items.length) kind = ''
  if (kind === 'text' && !text) kind = ''
  if (!kind) kind = rows.length ? 'table' : code ? 'code' : items.length ? 'list' : text ? 'text' : ''
  if (!kind) return null

  const section = { heading: heading || DEFAULT_HEADING[kind], kind }
  if (kind === 'text') section.text = text
  else if (kind === 'list' || kind === 'steps') section.items = items
  else if (kind === 'code') Object.assign(section, { code, language })
  else Object.assign(section, { headers, rows })
  return section
}

const DEFAULT_HEADING = { text: 'Notes', list: 'Key points', steps: 'Step by step', code: 'Example', table: 'Comparison' }

/** Turn old flat fields ("whatIsIt", "commonMistakes"...) into sections, in the legacy order. */
function legacyFieldsToSections(raw) {
  const found = {}
  const visit = (obj) => {
    for (const [key, value] of Object.entries(obj || {})) {
      const nk = normKey(key)
      if (['sections', 'content', 'fields', 'details', 'notes'].includes(nk) && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value)
        continue
      }
      const field = ALIAS_TO_LEGACY.get(nk)
      if (field && found[field] === undefined) found[field] = value
    }
  }
  visit(raw)

  const language = asString(found.codeLanguage)
  return LEGACY_SECTIONS
    .map((legacy) => normaliseSection({
      heading: legacy.heading,
      kind: legacy.kind,
      [legacy.kind === 'code' ? 'code' : legacy.kind === 'text' ? 'text' : 'items']: found[legacy.field],
      language,
    }))
    .filter(Boolean)
}

/**
 * Normalise ONE subtopic into { title, sections: [...] }, with any structure
 * the model put inside the content stripped out (content.js). Accepts the
 * current shape (sections array) and the legacy shape (one field per section).
 * Runs on every response from every provider.
 */
const sameTitle = (a, b) => stripListMarker(a).toLowerCase() === stripListMarker(b).toLowerCase()

/**
 * Which title a subtopic gets. The SOURCE task owns it: an AI title that
 * matches a source subtopic (ignoring any "a." it added) becomes that source
 * title verbatim; otherwise the source subtopic at the same position; the
 * AI's own (marker-stripped) title is used only when there is no source.
 */
export function resolveSubtopicTitle(aiTitle, sources = [], index = 0) {
  const cleaned = stripListMarker(cleanHeading(aiTitle))
  const matched = sources.find((s) => cleaned && sameTitle(s.title ?? s, cleaned))
  if (matched) return matched.title ?? matched
  const positional = sources[index]
  if (positional) return positional.title ?? positional
  return cleaned
}

export function normaliseTopic(raw, fallbackTitle = '', sources = [], index = 0) {
  if (!raw || typeof raw !== 'object') throw new Error('topic is not an object')

  const aiTitle = pick(raw, 'title', 'name', 'topic', 'subtopic', 'heading')
  const title = sources.length
    ? resolveSubtopicTitle(aiTitle, sources, index)
    : stripListMarker(cleanHeading(aiTitle)) || stripListMarker(fallbackTitle)
  const rawSections = pick(raw, 'sections', 'parts', 'blocks')

  const sections = Array.isArray(rawSections)
    ? rawSections.map(normaliseSection).filter(Boolean).slice(0, MAX_SECTIONS_PER_TOPIC)
    : legacyFieldsToSections(raw)

  if (!title) throw new Error('topic has no title')
  if (!sections.length) throw new Error(`topic "${title}" came back empty`)
  return { title, sections }
}

/** The AI's topics, whether it sent an array, an object keyed by title, or a wrapper. */
function extractTopics(raw) {
  for (const key of ['topics', 'subtopics', 'concepts', 'items']) {
    const value = raw[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([title, body]) =>
        body && typeof body === 'object' ? { title, ...body } : { title, text: body })
    }
  }
  return []
}

/** Unwrap { task: {...} } / { data: {...} } / { notes: {...} } / a single-key envelope. */
function unwrap(raw) {
  let obj = raw
  for (let i = 0; i < 3 && obj && typeof obj === 'object' && !Array.isArray(obj); i++) {
    if (extractTopics(obj).length) return obj
    const keys = Object.keys(obj)
    const inner = keys.length === 1 ? obj[keys[0]] : (obj.task || obj.data || obj.notes || obj.result)
    if (!inner || typeof inner !== 'object') break
    obj = inner
  }
  return obj
}

/**
 * The source subtopics decide the sections; the AI only supplies their words.
 *
 * This is the whole structural contract. The AI is asked for one topic per
 * subtopic, but models drop one, add an extra, reorder them, or rename them.
 * Iterating the AI's array (which this used to do) let any of those reshape the
 * Notion page. So instead we walk the SOURCE subtopics in order and, for each,
 * find the AI topic that belongs to it:
 *
 *   1. the one whose title matches it by name (order-proof), else
 *   2. the one the AI put in the same position, else
 *   3. nothing — reported as missing, never invented.
 *
 * Anything the AI returned beyond the source list is an invention and dropped.
 */
export function alignTopicsToSource(aiTopics, sources) {
  const aiTitleOf = (t) => stripListMarker(cleanHeading(pick(t || {}, 'title', 'name', 'topic', 'subtopic', 'heading')))
  const candidates = aiTopics.map((raw) => ({ raw, title: aiTitleOf(raw) }))

  // Pass 1 — by name. Order-proof, and the only signal that is actually
  // reliable, so it always wins.
  const pick_ = new Array(sources.length).fill(-1)
  const claimed = new Set()
  sources.forEach((source, i) => {
    const at = candidates.findIndex((c, j) => !claimed.has(j) && c.title && sameTitle(source.title ?? source, c.title))
    if (at !== -1) { pick_[i] = at; claimed.add(at) }
  })

  // There is no pass 2. Position is not evidence: a model that renamed a
  // subtopic and a model that invented one look identical from here, and
  // guessing files invented content under a real heading — a page that looks
  // right and teaches the wrong thing. Anything unmatched is regenerated
  // against the source subtopic instead, which is always correct.

  const topics = []
  const missing = []
  sources.forEach((source, index) => {
    const title = stripListMarker(source.title ?? source)
    const at = pick_[index]
    if (at === -1) { missing.push({ index, title }); return }
    try {
      const topic = normaliseTopic(candidates[at].raw, title, [source], 0)
      // normaliseTopic resolves against a one-element source list, so the title
      // is the source's own no matter what the model called it.
      // A section reading only "test" or "TODO" is a hole too — it just looks
      // like content. Treating it as missing sends it back to be written
      // properly instead of shipping the placeholder.
      if (!hasRealContent(topic)) { missing.push({ index, title }); return }
      topics.push({ index, ...topic, title })
    } catch {
      // Unusable content for a real subtopic is a hole to fill, not a section
      // to delete. The caller regenerates just this one.
      missing.push({ index, title })
    }
  })

  return { topics, missing }
}

/** Reviewer questions, from whichever key the model used. */
export function normaliseQuestions(body) {
  const raw = body?.reviewQuestions || body?.reviewerQuestions || body?.questions || body?.review_questions || []
  return (Array.isArray(raw) ? raw : [])
    .map((q) => ({
      question: cleanQuestionText(q?.question ?? q?.q ?? (typeof q === 'string' ? q : '')),
      answer: cleanQuestionText(q?.answer ?? q?.a ?? ''),
    }))
    .filter((q) => q.question && q.answer)
}

/**
 * Content that is a stand-in rather than study material. Deliberately narrow:
 * it matches a body that is ONLY one of these words, so prose that legitimately
 * discusses testing or checking is untouched.
 */
export function looksLikePlaceholder(text) {
  const trimmed = String(text ?? '').trim().replace(/[.!]+$/, '')
  // Long enough for "This is a test summary", short enough that no real
  // explanation can reach it. Anchored, so prose that merely begins with one of
  // these words ("Testing your reducer with Jest…") never matches.
  if (!trimmed || trimmed.length > 40) return false
  return /^(?:(?:this|here)\s+is\s+)?(?:an?\s+)?(?:test(?:ing)?|check(?:ing)?|todo|tbd|placeholder|example|sample|dummy|lorem ipsum|coming soon|n\/?a|content here|your text here)(?:\s+(?:summary|overview|content|text|response|notes?|page|data))?$/i.test(trimmed)
}

/** The overview line, unless the model filled it with a stand-in. */
function usableSummary(raw) {
  const summary = cleanProse(raw)
  // "This is a test." was reaching Notion as the page's 📌 overview. An absent
  // overview is fine — the five subtopics are the structure; a placeholder one
  // is not, because it looks like real content.
  return looksLikePlaceholder(summary) ? '' : summary
}

/** Does this topic actually teach something? */
export function hasRealContent(topic) {
  return (topic.sections || []).some((section) => {
    const text = section.kind === 'code' ? section.code
      : section.kind === 'text' ? section.text
      : section.kind === 'table' ? (section.rows || []).flat().join(' ')
      : (section.items || []).join(' ')
    const value = String(text ?? '').trim()
    return value.length > 0 && !looksLikePlaceholder(value)
  })
}

/**
 * The last gate before anything is written to Notion: does what we built still
 * match the task it came from? Returns a list of problems, empty when sound.
 */
export function validateNotes(notes, task) {
  const problems = []
  const sources = task.subtopics?.length ? task.subtopics : []

  if (stripListMarker(notes.title) !== stripListMarker(task.title)) {
    problems.push(`the main title became "${notes.title}" instead of "${task.title}"`)
  }
  if (notes.number !== task.number) problems.push('the task number changed')

  const titles = notes.topics.map((t) => stripListMarker(t.title))
  for (const source of sources) {
    const wanted = stripListMarker(source.title ?? source)
    if (!titles.some((t) => sameTitle(t, wanted))) problems.push(`"${wanted}" is missing`)
  }
  for (const [i, title] of titles.entries()) {
    if (sources.length && !sources.some((s) => sameTitle(s.title ?? s, title))) {
      problems.push(`"${title}" is not one of the task's subtopics`)
    }
    // Rule: a subtopic may only repeat the parent title if the task really has
    // one by that name; otherwise the heading is duplicated in Notion.
    if (sameTitle(title, task.title) && !sources.some((s) => sameTitle(s.title ?? s, task.title))) {
      problems.push('a subtopic repeats the main task title')
    }
    if (titles.findIndex((t) => sameTitle(t, title)) !== i) problems.push(`"${title}" appears twice`)
  }
  for (const topic of notes.topics) {
    if (!hasRealContent(topic)) problems.push(`"${topic.title}" has no real study content`)
  }
  if (notes.summary && looksLikePlaceholder(notes.summary)) {
    problems.push('the overview is placeholder text')
  }
  if (notes.reviewQuestions.length !== 5) {
    problems.push(`${notes.reviewQuestions.length} reviewer questions instead of 5`)
  }
  return problems
}

export function normaliseTask(raw, task) {
  if (!raw || typeof raw !== 'object') throw new Error('response is not an object')
  const body = unwrap(raw)
  const aiTopics = extractTopics(body)

  // With no subtopics on the source task there is no structure to preserve, so
  // the model's own topics stand — minus any that merely repeat the task title,
  // which would render as the same heading twice in Notion.
  if (!task.subtopics?.length) {
    const topics = aiTopics
      .map((t, i) => { try { return normaliseTopic(t, '', [], i) } catch { return null } })
      .filter(Boolean)
      .filter((t) => !sameTitle(t.title, task.title))
    if (!topics.length) throw new Error('no usable topics in the response')
    return {
      number: task.number,
      title: stripListMarker(task.title),
      summary: usableSummary(body.summary),
      topics,
      reviewQuestions: normaliseQuestions(body).slice(0, 5),
      missingTopics: [],
    }
  }

  const { topics, missing } = alignTopicsToSource(aiTopics, task.subtopics)
  if (!topics.length) throw new Error('no usable topics in the response')

  return {
    // The Brototype task owns its number and title. A model that restarts
    // numbering at 1 or echoes the course name as the title must not be able
    // to rename the parent toggle - that is the app's structure, not content.
    number: task.number,
    title: stripListMarker(task.title),
    summary: usableSummary(body.summary),
    topics,
    reviewQuestions: normaliseQuestions(body).slice(0, 5),
    // Real subtopics the model did not usably answer. The caller fills these in
    // one at a time rather than shipping a page with holes in it.
    missingTopics: missing,
  }
}

/**
 * A deliberately tiny schema used by Test Connection.
 *
 * Test Connection runs the REAL generateStructured() path with this, rather
 * than a simpler hand-rolled request. That matters: it exercises the system
 * prompt, the provider's structured-output mechanism and the JSON parsing, so
 * "Test succeeded" actually predicts that generation will succeed.
 */
export const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'string', description: 'The single word: ok' },
    model: { type: 'string', description: 'The name of the model answering, or an empty string.' },
  },
  required: ['ok', 'model'],
}

export const PROBE_PROMPT = {
  system: 'You are a connection test. Answer with structured data only.',
  user: 'Reply with ok set to "ok" and model set to the name of the model answering.',
}
