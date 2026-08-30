/**
 * Study Style - HOW the AI explains things. Never WHAT it explains.
 *
 * Two modes:
 *   default  the built-in style below
 *   custom   the student's own instructions, saved in chrome.storage.local
 *
 * This file is deliberately free of chrome APIs so every rule in it can be
 * unit-tested. prompt.js is the only consumer: it places the resolved style
 * into a delimited block INSIDE the system message, after the application's
 * own rules and before a precedence clause. See buildSystemPrompt() there.
 *
 * What the style can influence: tone, depth, which examples, what to
 * emphasise, how long each field is.
 * What it cannot influence: the output schema (enforced by the provider API
 * during decoding, and again by normaliseTask()), the list of subtopics (built
 * by the app from the detected task), and anything about providers or Notion.
 */

export const STUDY_STYLE_MODES = ['default', 'custom']

/** Hard cap on a custom prompt. Enough for a page of instructions, not a novel. */
export const CUSTOM_PROMPT_MAX_LENGTH = 4000

export const DEFAULT_STUDY_STYLE = `SHORT + SIMPLE + BEGINNER-FRIENDLY + EASY TO VISUALIZE + COMPLETE ENOUGH TO STUDY.
Not: long + everything about the topic + unnecessary theory. Teach the MINIMUM a beginner needs to clearly understand the topic.

Explain like a knowledgeable friend sitting next to a beginner, not like a textbook.

Language:
- Very simple English. Short sentences. No long paragraphs.
- Explain a difficult word the moment you use it, in simple words. For example:
  "Memoization means remembering a previous result so we don't calculate it again unnecessarily."
- Say WHY something is used, not only what it is - but in a line, not an essay.

How much to write - decide from the topic, never from a template:
- A simple theory topic gets a simple answer. "What is Vite?" is: what it is, and a short list of what it helps you do. Then STOP. No history, no internals, no analogy, no mistakes.
- A concept with code gets what a beginner needs to use it: what it is, a one-line real-world example, basic syntax, a small example. A comparison table when two things are easily confused (useState vs useContext). A common mistake only when beginners really make it.
- Never add a section that does not help understanding of THIS topic.

Main parts / stages - only when the topic really has them:
- If a topic has internal steps, stages or parts a beginner MUST know (creating → providing → consuming for useContext; request → route → controller → response for an API), give them as ONE short list: each part is one line, bold name, dash, the key idea.
- Three parts? Show three. Five? Show five. No real parts? No such section - never invent stages to fill space.
- One line each. Never a paragraph per stage.

Real-life example - make it EASY TO IMAGINE, not merely short:
- Use a simple, familiar, everyday situation the student can picture at once: a wardrobe, a cashier, a noticeboard, a queue at a shop.
- One line is often enough ("Theme switching: light mode and dark mode."). But when a slightly bigger picture makes the idea click, use 3-6 short lines - a tiny scene, simple objects, emojis where they help (👕 shirts, 👖 pants, 🧦 socks - one pile vs sorted sections = a data structure).
- Never a long story, never unnecessary explanation. Stop as soon as the idea is clear.

Code:
- Small first. Explain the important variables and what happens, step by step, only when it is not obvious.
- Show the complete working code only when the small example is not enough to actually use the concept.

Style reference for the level of detail (a reference, not a template):

  What is Vite?
  Vite is a frontend build tool and development server.
  It helps: create a React project · start a local dev server · reload changes quickly · build for production.

  What is useContext?
  useContext lets a component get shared data without passing props through every component.
  Main parts of useContext:
    **Creating** — createContext() creates the context that holds shared data.
    **Providing** — Provider gives the shared data to components.
    **Consuming** — useContext() lets a component read the shared data.
  Real-world example: a dark/light theme shared by many components.
  Simple example: const theme = useContext(ThemeContext);

Reviewer questions:
- Five practical questions a Brototype reviewer could realistically ask about this task.
- They test understanding, not memorisation ("why would you choose X here?" rather than "what is X?").
- Each answer is short and something the student can say out loud in a review.`

/** The settings object stored under config.studyStyle. */
export const DEFAULT_STUDY_STYLE_SETTINGS = Object.freeze({
  mode: 'default',
  customPrompt: '',
})

/**
 * Clean user-typed instructions before they go anywhere near a prompt:
 * control characters out, line endings normalised, whitespace trimmed,
 * length capped.
 *
 * Deliberately does NOT try to detect "bad" instructions. The schema is
 * protected mechanically (provider-side decoding + normaliseTask), not by
 * guessing at intent.
 */
export function sanitiseCustomPrompt(text) {
  return String(text ?? '')
    // C0 controls except tab/newline, plus DEL. Written as escapes on purpose.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, CUSTOM_PROMPT_MAX_LENGTH)
}

/**
 * Turn stored settings into the style text that will actually be used.
 * Returns { mode, text, source } where `source` says which one won and why -
 * the job log shows it, so a run is never ambiguous about what it did.
 */
export function resolveStudyStyle(settings) {
  const mode = STUDY_STYLE_MODES.includes(settings?.mode) ? settings.mode : 'default'
  const custom = sanitiseCustomPrompt(settings?.customPrompt)

  if (mode === 'custom' && custom) {
    return { mode: 'custom', text: custom, source: 'custom' }
  }
  if (mode === 'custom' && !custom) {
    // An empty custom prompt is not an instruction to explain nothing.
    return { mode: 'default', text: DEFAULT_STUDY_STYLE, source: 'default (custom prompt was empty)' }
  }
  return { mode: 'default', text: DEFAULT_STUDY_STYLE, source: 'default' }
}

/** What "Reset to Default" writes back. */
export const resetStudyStyle = () => ({ ...DEFAULT_STUDY_STYLE_SETTINGS })

/** One line for the Options page and the job log. */
export function describeStudyStyle(settings) {
  const { source } = resolveStudyStyle(settings)
  if (source === 'custom') return 'Custom study style'
  return source.includes('empty') ? 'Default study style (custom prompt is empty)' : 'Default study style'
}
