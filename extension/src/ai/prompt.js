/**
 * Prompt construction, kept away from the network code so it can be tuned
 * without touching anything else.
 *
 * The system message is assembled from THREE clearly separated parts:
 *
 *   CORE_RULES        owned by the application. Structure, required fields,
 *                     "never invent subtopics". Not user-editable.
 *   STUDY STYLE       owned by the student. Tone, depth, examples. Either the
 *                     built-in default or their custom text (studyStyle.js).
 *   PRECEDENCE        owned by the application. Restates, AFTER the style,
 *                     that structure wins over style if they ever conflict.
 *
 * The user message carries only task data, built from the detected task.
 * Style never reaches it, so style cannot change which subtopics are covered.
 *
 * None of this wording is what actually guarantees valid output. The schema
 * is enforced by the provider API during decoding and by normaliseTask()
 * afterwards. The prompt is for quality; the code is for safety.
 */

import { resolveStudyStyle, DEFAULT_STUDY_STYLE } from './studyStyle.js'
import { SECTION_KINDS, MAX_SECTIONS_PER_TOPIC } from './schema.js'

export const CORE_RULES = `You write study notes for a Brototype student, as structured data.

Rules that always apply:
- Cover EXACTLY the subtopics listed in the request, in that order, one entry each. Never add, rename, merge or skip a subtopic. Never invent subtopics or details the request does not contain.
- Be technically correct. Simple is good; wrong is not.

How the notes become the student's notebook:
Each subtopic is a dropdown headed "a. <subtopic>" inside the main topic's dropdown "1. <task>".
Inside it, each section you return becomes a small heading with its content under it, in the order you give.

You decide which sections a subtopic needs. Include ONLY what is needed to understand THIS topic:
- A simple theory topic ("What is Vite?") may need one or two sections: what it is, and a short list of what it does. Then stop.
- A concept with code ("useContext") may need five or six: what it is, its main parts if it has them, a real-life example, basic syntax, a simple example, maybe a comparison or a common mistake.
- Never add a section just because it could exist. No history, no internals, no analogy, no "why does it exist", no mistakes, no tips - unless understanding this topic actually needs it.
- At most ${MAX_SECTIONS_PER_TOPIC} sections. Fewer is usually better.

Each section has one "kind": ${SECTION_KINDS.map((k) => `"${k}"`).join(', ')}.
- "text": a few short sentences or short lines - up to about six for a real-life example that needs a small scene.
- "list": short bullet points, one idea per item.
- "code": code only - no prose and no markdown fences. Put the language in "language".
- "table": a small comparison, e.g. useState vs useContext. Headers plus a few rows.
Fill only the content field for that kind; leave the others empty.

Formatting:
- The heading is a few plain words ("What is useContext?", "Real-world example", "Simple example"). Do not repeat the heading inside the content.
- Plain text. **bold** for emphasis and \`backticks\` for code identifiers are allowed. No markdown headings, no bullet characters, no numbered prefixes - list items are already a list.
- Do not repeat one section's content in another.`

export const PRECEDENCE = `The study style above describes HOW to explain: tone, depth, which examples, what to emphasise. It does not change WHAT you produce. Whatever it says:
- the output shape is fixed by the schema and the rules at the top;
- the subtopics to cover are exactly the ones listed in the request;
- you never add, rename, skip or merge subtopics.
If the study style conflicts with those rules, the rules win.`

/**
 * CORE_RULES + delimited style block + PRECEDENCE.
 * `studyStyle` is the resolved object from resolveStudyStyle(), or absent
 * (tests and older callers), in which case the default style is used.
 */
export function buildSystemPrompt(studyStyle) {
  const text = studyStyle?.text || DEFAULT_STUDY_STYLE
  return `${CORE_RULES}

=== STUDY STYLE - the student's preference for how things are explained ===
<study_style>
${text}
</study_style>
=== END STUDY STYLE ===

${PRECEDENCE}`
}

/** Resolve whatever the caller handed us into a style object, once. */
const styleFrom = (options) =>
  options?.studyStyle?.text ? options.studyStyle : resolveStudyStyle(options?.studyStyleSettings)

/** Renders the subtopic tree (including roman-numeral children) as indented text. */
function renderSubtopics(subtopics, indent = '  ') {
  return subtopics
    .map((s) => {
      const children = s.children?.length ? `\n${renderSubtopics(s.children, `${indent}  `)}` : ''
      return `${indent}- ${s.title}${children}`
    })
    .join('\n')
}

/**
 * The prompt for one whole main task. Note the explicit list of topics the model
 * must produce - this is what stops it inventing or skipping subtopics.
 */
export function buildTaskPrompt(task, options = {}) {
  const { unit } = options
  const topics = task.subtopics.length ? task.subtopics : [{ title: task.title, children: [] }]
  const context = [unit?.title && `Course module: ${unit.title}`, unit?.sem, unit?.paper, unit?.module]
    .filter(Boolean)
    .join(' · ')

  return {
    system: buildSystemPrompt(styleFrom(options)),
    user: `${context ? `${context}\n\n` : ''}Brototype task ${task.number}: ${task.title}

Write study notes for EXACTLY these ${topics.length} subtopics, in this order, one entry in "topics" per subtopic:

${renderSubtopics(topics)}

Then write exactly 5 review questions for the task as a whole, each with its answer.

${topics.length === 1 && !task.subtopics.length
  ? 'This task has no listed subtopics, so treat the task title itself as the single topic.'
  : ''}`,
  }
}

/** Fallback prompt used when a task is too large to generate in one response. */
export function buildTopicPrompt(topic, task, options = {}) {
  const { unit } = options
  const children = topic.children?.length
    ? `\n\nIt has these sub-points, cover all of them:\n${renderSubtopics(topic.children)}`
    : ''

  return {
    system: buildSystemPrompt(styleFrom(options)),
    user: `Course context: Brototype task ${task.number} — ${task.title}${unit?.title ? ` (${unit.title})` : ''}

Write study notes for this ONE subtopic: ${topic.title}${children}`,
  }
}

export function buildQuestionsPrompt(task, options = {}) {
  const { unit } = options
  const topics = task.subtopics.map((s) => s.title).join(', ') || task.title
  return {
    system: buildSystemPrompt(styleFrom(options)),
    user: `Brototype task ${task.number}: ${task.title}${unit?.title ? ` (${unit.title})` : ''}
Subtopics covered: ${topics}

Write exactly 5 review questions a Brototype reviewer could realistically ask about this task, each with its answer.
Return only the "reviewQuestions" array.`,
  }
}
