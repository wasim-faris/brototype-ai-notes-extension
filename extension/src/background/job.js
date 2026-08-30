/**
 * job.js - the shape of a generation run, and how it is persisted.
 *
 * WHY THIS EXISTS: an MV3 popup is destroyed the moment you click away from it.
 * If the popup held the progress state, closing it would lose your run. So the
 * job lives in chrome.storage.local instead. The popup is a pure viewer: it
 * reads this object and re-renders whenever it changes. Closing the popup, or
 * even Chrome shutting the service worker down, cannot lose your progress.
 */

export const JOB_KEY = 'job'
const MAX_LOG = 200

export const STEP_KEYS = ['detect', 'page', 'generate', 'finish']

export function createJob({ pageTitle, unit, tasks, strategy }) {
  return {
    // The full task list is stored on the job so "Resume" and "Retry failed"
    // work even after the popup was closed and detection state was lost.
    sourceTasks: tasks,
    id: `job_${Date.now()}`,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    pageTitle,
    unit,
    strategy,
    notionPageId: null,
    notionPageUrl: null,
    pageAction: null,
    currentMessage: 'Starting…',
    steps: [
      { key: 'detect', label: 'Detecting tasks', status: 'done' },
      { key: 'page', label: 'Preparing the Notion page', status: 'pending' },
      { key: 'generate', label: 'Generating notes', status: 'pending' },
      { key: 'finish', label: 'Finishing up', status: 'pending' },
    ],
    tasks: tasks.map((t) => ({
      number: t.number,
      title: t.title,
      subtopicCount: t.subtopics.length,
      status: 'pending',      // pending | active | done | failed | skipped
      message: '',
    })),
    log: [],
    error: null,
    warnings: [],
  }
}

export async function readJob() {
  const stored = await chrome.storage.local.get(JOB_KEY)
  return stored[JOB_KEY] || null
}

export async function writeJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job })
  return job
}

export async function clearJob() {
  await chrome.storage.local.remove(JOB_KEY)
}

/** Apply a change and persist immediately, so the popup always sees the truth. */
export async function updateJob(mutate) {
  const job = await readJob()
  if (!job) return null
  mutate(job)
  return writeJob(job)
}

export function appendLog(job, message, level = 'info') {
  job.log.push({ time: Date.now(), message, level })
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG)
  // Only ordinary progress becomes the live line. A retry or a failure is
  // real information, but it belongs in the log behind "Details" — letting it
  // take over made the panel read "Retrying in 1s (attempt 2 of 3)" as though
  // that were the work being done.
  if (level === 'info') job.currentMessage = message
}

export const setStep = (job, key, status) => {
  const step = job.steps.find((s) => s.key === key)
  if (step) step.status = status
}

export const setTask = (job, number, patch) => {
  const task = job.tasks.find((t) => t.number === number)
  if (task) Object.assign(task, patch)
}

/** True when a stored job says "running" but nothing is actually running. */
export const isStale = (job, runningId) => job?.status === 'running' && job.id !== runningId
