/**
 * generator.js - turns ONE Brototype task into validated study notes.
 *
 * This is where all the "the AI is unreliable" handling lives, so neither the
 * provider nor the Notion builder has to care. It contains NO provider-specific
 * code: it only ever calls provider.generateStructured(), whichever AI that is.
 *
 *   - paces requests so the provider's per-minute limit is not tripped
 *   - retries retryable failures with exponential backoff
 *   - if a task is too big for one response, splits it into one call per
 *     subtopic and stitches the results back together
 *   - validates everything before it is allowed anywhere near Notion
 */

import { getProvider } from './provider.js'
import { TASK_SCHEMA, TOPIC_ONLY_SCHEMA, QUESTIONS_SCHEMA, normaliseTask, normaliseTopic, normaliseQuestions, validateNotes } from './schema.js'
import { buildTaskPrompt, buildTopicPrompt, buildQuestionsPrompt } from './prompt.js'
import { AppError } from '../lib/errors.js'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new AppError('CANCELLED', 'Generation was cancelled.')) }, { once: true })
})

/**
 * Simple pacer shared across a whole run: never start a call sooner than
 * (60 / requestsPerMinute) seconds after the previous one.
 */
export function createPacer(requestsPerMinute) {
  const minGap = requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0
  let nextAllowed = 0
  return async (signal) => {
    const wait = nextAllowed - Date.now()
    if (wait > 0) await sleep(wait, signal)
    nextAllowed = Date.now() + minGap
  }
}

async function callWithRetry(prompt, schema, { provider, config, signal, pace, onProgress, attempts = 3 }) {
  // Resolved once per run by the caller; falling back keeps this callable in tests.
  const active = provider || getProvider(config)
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await pace(signal)
    try {
      return await active.generateStructured(prompt, schema, signal)
    } catch (error) {
      lastError = AppError.from(error)
      if (!lastError.retryable || attempt === attempts) throw lastError

      // 1s, 4s, 9s... plus extra room when it is specifically a rate limit.
      const backoff = attempt * attempt * 1000 + (lastError.code === 'AI_RATE_LIMIT' ? 15_000 : 0)
      onProgress?.({ type: 'retry', message: `${lastError.message} Retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1} of ${attempts}).` })
      await sleep(backoff, signal)
    }
  }
  throw lastError
}

/** Ask for one subtopic on its own. Used to fill a hole, and by Plan B below. */
async function generateOneTopic(subtopic, task, options) {
  const raw = await callWithRetry(buildTopicPrompt(subtopic, task, options), TOPIC_ONLY_SCHEMA, options)
  return normaliseTopic(raw, subtopic.title, [subtopic], 0)
}

/**
 * Re-ask for the subtopics the model skipped or answered unusably.
 *
 * A source subtopic is a requirement, not a suggestion: the page must have a
 * section for every one. Filling them individually keeps the structure intact
 * without discarding the topics that did come back.
 */
async function fillMissingTopics(notes, task, options) {
  const { onProgress } = options
  const stillMissing = []

  for (const gap of notes.missingTopics || []) {
    const subtopic = task.subtopics[gap.index]
    onProgress?.({ type: 'status', message: `Task ${task.number}: writing "${gap.title}"` })
    try {
      const topic = await generateOneTopic(subtopic, task, options)
      notes.topics.push({ index: gap.index, ...topic, title: gap.title })
    } catch (error) {
      const appError = AppError.from(error)
      if (appError.code === 'CANCELLED') throw appError
      stillMissing.push({ title: gap.title, message: appError.message })
    }
  }

  // Source order, always — the model's ordering never reaches Notion.
  notes.topics.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  notes.missingTopics = []
  return stillMissing
}

/**
 * Every task ends with five reviewer questions. When the task response came
 * back with fewer, they are requested on their own rather than left short.
 */
async function ensureQuestions(notes, task, options) {
  if (notes.reviewQuestions.length >= 5) return
  try {
    const raw = await callWithRetry(buildQuestionsPrompt(task, options), QUESTIONS_SCHEMA, options)
    const seen = new Set(notes.reviewQuestions.map((q) => q.question.toLowerCase()))
    for (const question of normaliseQuestions(raw)) {
      if (notes.reviewQuestions.length >= 5) break
      if (seen.has(question.question.toLowerCase())) continue
      seen.add(question.question.toLowerCase())
      notes.reviewQuestions.push(question)
    }
  } catch {
    // Questions are valuable but not worth failing a whole task over.
  }
}

/** Plan B: one request per subtopic, then one request for the questions. */
async function generateBySplitting(task, options) {
  const { onProgress } = options
  const sources = task.subtopics?.length ? task.subtopics : []
  const topics = []
  const failed = []

  if (!sources.length) {
    // No subtopics to preserve: one request for the whole task, and the model's
    // own topics stand. normaliseTask drops any that repeat the task title.
    const raw = await callWithRetry(buildTaskPrompt(task, options), TASK_SCHEMA, options)
    return { notes: normaliseTask(raw, task), partial: [] }
  }

  for (const [index, subtopic] of sources.entries()) {
    onProgress?.({ type: 'status', message: `Task ${task.number}: writing "${subtopic.title}" (${index + 1}/${sources.length})` })
    try {
      topics.push({ index, ...(await generateOneTopic(subtopic, task, options)) })
    } catch (error) {
      const appError = AppError.from(error)
      if (appError.code === 'CANCELLED') throw appError
      // A failure here is a hole, not a reason to stop: the remaining subtopics
      // are still worth asking for, and the caller retries the holes once more
      // before deciding the task cannot be written.
      failed.push({ index, title: subtopic.title, message: appError.message })
    }
  }

  if (!topics.length) {
    throw new AppError('AI_FAILED', `Could not generate any notes for task ${task.number} ("${task.title}"). ${failed[0]?.message || ''}`.trim())
  }

  return {
    notes: {
      number: task.number,
      title: task.title,
      summary: '',
      topics,
      reviewQuestions: [],
      missingTopics: failed,
    },
    partial: [],
  }
}

/**
 * Generate notes for one task. Always returns { notes, partial } - `partial`
 * lists subtopics that could not be written, so the UI can tell you honestly.
 *
 * The shape of the result is fixed by the TASK, not by the response: one
 * section per source subtopic, in source order, then five reviewer questions.
 */
export async function generateTaskNotes(task, options) {
  const { onProgress } = options
  const sourceCount = task.subtopics?.length || 0
  onProgress?.({
    type: 'status',
    message: sourceCount
      ? `Task ${task.number}: writing notes for ${sourceCount} subtopic(s)`
      : `Task ${task.number}: no subtopics were detected on the page — writing from the title alone`,
  })

  let notes
  let partial = []

  try {
    const raw = await callWithRetry(buildTaskPrompt(task, options), TASK_SCHEMA, options)
    notes = normaliseTask(raw, task)
  } catch (error) {
    const appError = AppError.from(error)
    if (appError.code === 'CANCELLED') throw appError

    // Too big for one response, or the response came back unusable: split it up.
    const shouldSplit = appError.code === 'AI_TRUNCATED' || appError.code === 'AI_INVALID_JSON' || /no usable topics|not an object/.test(appError.message)
    if (!shouldSplit) throw appError

    onProgress?.({ type: 'status', message: `Task ${task.number} was too large for one response — generating it one subtopic at a time.` })
    ;({ notes, partial } = await generateBySplitting(task, options))
  }

  // --- repair, then check, before any of this reaches Notion ---------------
  const unwritable = await fillMissingTopics(notes, task, options)
  await ensureQuestions(notes, task, options)

  // A source subtopic that still has no content after being asked for again is
  // the end of the road. Writing the page anyway would produce a page whose
  // sections no longer match the task — missing headings, and the letters after
  // the gap shifted onto the wrong subtopics. A task that fails can be retried;
  // a page that is quietly wrong gets studied from.
  if (unwritable.length) {
    const names = unwritable.map((t) => `"${t.title}"`).join(', ')
    throw new AppError('AI_INCOMPLETE_TASK',
      `Task ${task.number} ("${task.title}") was not written: ${names} could not be generated, and the page must contain every subtopic. ${unwritable[0].message}`,
      { retryable: true })
  }

  const problems = validateNotes(notes, task)
  if (problems.length) {
    // Structure is guaranteed by the alignment above, so anything left here is
    // worth saying out loud rather than silently accepting.
    onProgress?.({ type: 'status', message: `Task ${task.number}: ${problems.join('; ')}` })
  }

  return { notes, partial }
}
