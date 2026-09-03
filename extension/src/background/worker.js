/**
 * worker.js - the MV3 service worker. The only place a full run happens.
 *
 * Everything expensive (AI calls, Notion writes) runs HERE and not in the popup,
 * because the popup is destroyed as soon as you click away from it. The popup
 * only sends "start" and then watches chrome.storage for progress.
 *
 * Keeping the worker alive: Chrome shuts an idle service worker down after ~30
 * seconds. Our pacer deliberately waits between AI calls, which counts as idle.
 * So while a job runs we ping a cheap chrome API every 20 seconds, which resets
 * that timer. It stops the moment the job finishes.
 */

import { getConfig, setConfig, setProviderConfig, resolveNotionToken, notionAuthMethod } from '../lib/storage.js'
import { AppError, errors } from '../lib/errors.js'
import { createPacer, generateTaskNotes } from '../ai/generator.js'
import { getProvider } from '../ai/provider.js'
import { retryTransient, DIRECT_RETRY_DELAYS, BACKEND_RETRY_DELAYS } from '../ai/retry.js'
import { resolveStudyStyle, DEFAULT_STUDY_STYLE_SETTINGS } from '../ai/studyStyle.js'
import { notion, pageTitle } from '../notion/client.js'
import { authorize, redirectUri, withNotionAuth } from '../notion/oauth.js'
import { resolveBackendUrl, IS_DEV_BUILD, DEFAULT_BACKEND_URL } from '../lib/env.js'
import { resolveTargetPage, writeTask, findExistingPage, createDestinationPage } from '../notion/pages.js'
import { createJob, readJob, writeJob, updateJob, appendLog, setStep, setTask, isStale } from './job.js'

let currentRun = null // { id, abort }
let keepAliveTimer = null

function startKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000)
}
function stopKeepAlive() {
  clearInterval(keepAliveTimer)
  keepAliveTimer = null
}

/** If the worker was killed mid-run, say so instead of showing a frozen job. */
async function reconcileOnStartup() {
  const job = await readJob()
  if (isStale(job, currentRun?.id)) {
    job.status = 'error'
    job.error = new AppError('INTERRUPTED',
      'Chrome stopped the extension while notes were being generated. The tasks already written to Notion are safe — press Resume to finish the rest.',
    ).toJSON()
    appendLog(job, 'Run interrupted by the browser.', 'error')
    await writeJob(job)
  }
}
chrome.runtime.onStartup.addListener(reconcileOnStartup)
chrome.runtime.onInstalled.addListener(reconcileOnStartup)
reconcileOnStartup()

// Clicking the toolbar icon opens the side panel, which stays open while you
// switch tabs or click into pages - unlike a popup, which closes on blur.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

// --- the run --------------------------------------------------------------

/** Fails fast, before a job object exists, so the popup can show the problem. */
async function preflight() {
  const config = await getConfig()
  if (!resolveNotionToken(config)) throw errors.notionNotConnected()
  if (!config.notionParentId) throw errors.notionNoParent()
  getProvider(config) // throws if the AI is not configured

  // One cheap call, so a run of several minutes does not start against
  // credentials Notion has already revoked. It also renews an expired OAuth
  // token in place, which is why the config is re-read afterwards.
  await withNotionAuth((token) => notion.me(token))
  return getConfig()
}

/** Failures that will repeat for every task, so the run stops at the first. */
const RUN_STOPPING = ['AI_BAD_KEY', 'AI_FORBIDDEN', 'AI_QUOTA', 'AI_BAD_MODEL', 'AI_NOT_CONFIGURED', 'AI_SERVICE_ERROR', 'BACKEND_NO_KEY', 'NOTION_UNAUTHORIZED', 'NOTION_FORBIDDEN', 'NOTION_NOT_SHARED']

/**
 * One sentence per failed task, in the user's terms. In direct mode the key
 * and the account are the user's own, so the provider's verdict ("OpenRouter
 * rejected your API key") is exactly what they need to hear.
 */
function taskFailureMessage(error, mode) {
  if (error.code.startsWith('NOTION_')) return error.message
  if (['AI_BAD_KEY', 'AI_FORBIDDEN', 'AI_QUOTA', 'AI_NOT_CONFIGURED', 'AI_BAD_MODEL'].includes(error.code)) {
    return mode === 'direct' ? error.message : 'The AI service is temporarily unavailable. Please try again.'
  }
  if (['AI_SERVICE_ERROR', 'BACKEND_NO_KEY', 'BACKEND_UNREACHABLE'].includes(error.code)) {
    return 'The AI service is temporarily unavailable. Please try again.'
  }
  return "Couldn't generate notes for this task. You can retry it."
}

async function runJob({ tasks, unit, pageTitle: title, strategy, resumeJobId }) {
  const config = await getConfig()
  // Resolved once so every task in this run uses the same provider, even if the
  // Options page is changed while the run is in flight.
  const provider = getProvider(config)
  // Resolved once too: OAuth token if connected that way, otherwise the
  // integration secret an existing user pasted before OAuth existed.
  const notionToken = resolveNotionToken(config)
  // The built-in default style, always. The Options UI for a custom style was
  // removed on purpose; the style text itself (ai/studyStyle.js) is unchanged.
  const studyStyle = resolveStudyStyle(DEFAULT_STUDY_STYLE_SETTINGS)
  let job = await readJob()
  const resuming = resumeJobId && job?.id === resumeJobId

  if (!resuming) {
    job = createJob({ pageTitle: title, unit, tasks, strategy })
    await writeJob(job)
  } else {
    job.status = 'running'
    job.error = null
    await writeJob(job)
  }

  const abort = new AbortController()
  currentRun = { id: job.id, abort }
  startKeepAlive()

  const onProgress = async (event) => {
    await updateJob((j) => appendLog(j, event.message, event.type === 'retry' ? 'warn' : 'info'))
  }

  try {
    // --- 1. the Notion page ---
    await updateJob((j) => {
      setStep(j, 'page', 'active')
      appendLog(j, `Using ${provider.describe()}`)
      appendLog(j, `Study style: ${studyStyle.source}`)
      appendLog(j, 'Preparing the Notion page…')
    })

    let pageId = job.notionPageId
    if (!pageId) {
      const target = await resolveTargetPage({
        token: notionToken,
        parentId: config.notionParentId,
        title,
        strategy,
        unit,
        taskCount: tasks.length,
        signal: abort.signal,
        onProgress,
      })
      pageId = target.page.id
      await updateJob((j) => {
        j.notionPageId = pageId
        j.notionPageUrl = target.page.url || null
        j.pageTitle = target.title
        j.pageAction = target.action
        appendLog(j, target.action === 'updated'
          ? `Replaced the contents of "${target.title}".`
          : `Created "${target.title}" in Notion.`)
      })
    }
    await updateJob((j) => { setStep(j, 'page', 'done'); setStep(j, 'generate', 'active') })

    // --- 2. one task at a time ---
    // Each provider has its own sane rate; the setting is an optional override.
    const pace = createPacer(config.aiRequestsPerMinute ?? provider.resolved.requestsPerMinute)
    const doneNumbers = new Set((job.tasks || []).filter((t) => t.status === 'done').map((t) => t.number))
    let failures = 0

    for (const task of tasks) {
      if (doneNumbers.has(task.number)) continue
      if (abort.signal.aborted) break

      await updateJob((j) => {
        setTask(j, task.number, { status: 'active', message: '' })
        appendLog(j, `Task ${task.number}: ${task.title}`)
      })

      // Logged before the first AI call so a mismatch is visible in Details
      // rather than inferred from the page that comes out. Counts and titles
      // only — no page content, no keys.
      await updateJob((j) => appendLog(j,
        `Task ${task.number}: source subtopics = ${task.subtopics.length} [${task.subtopics.map((sub) => sub.title).join(' | ')}]`,
        'debug'))

      try {
        const { notes, partial } = await generateTaskNotes(task, {
          provider, config, unit, pace, signal: abort.signal, onProgress,
          studyStyle,
        })

        // The structural invariant, checked against the source one last time
        // before anything is written.
        await updateJob((j) => appendLog(j,
          `Task ${task.number}: writing ${notes.topics.length} section(s) for ${task.subtopics.length} source subtopic(s)`,
          'debug'))

        await writeTask(notionToken, pageId, notes, { signal: abort.signal, onProgress })

        await updateJob((j) => {
          setTask(j, task.number, {
            status: 'done',
            message: partial.length ? `${partial.length} subtopic(s) could not be written` : '',
          })
          if (partial.length) j.warnings.push(`Task ${task.number}: ${partial.map((p) => p.title).join(', ')} could not be generated.`)
          appendLog(j, `Task ${task.number} written to Notion.`)
        })
      } catch (error) {
        const appError = AppError.from(error)
        if (appError.code === 'CANCELLED') throw appError

        failures++
        await updateJob((j) => {
          // The task line says what the user can do; the exact reason (which
          // subtopic, what the provider said) is kept in Details.
          setTask(j, task.number, { status: 'failed', message: taskFailureMessage(appError, provider.mode) })
          appendLog(j, `Task ${task.number} failed: ${appError.message}`, 'error')
          if (appError.detail) appendLog(j, `Task ${task.number}: ${appError.detail}`, 'debug')
        })

        // A whole-run problem (no AI service, no permission) will fail every task, so stop.
        if (RUN_STOPPING.includes(appError.code)) throw appError
      }
    }

    // --- 3. done ---
    await updateJob((j) => {
      setStep(j, 'generate', 'done')
      setStep(j, 'finish', 'done')
      j.status = abort.signal.aborted ? 'cancelled' : 'done'
      j.finishedAt = Date.now()
      const written = j.tasks.filter((t) => t.status === 'done').length
      appendLog(j, abort.signal.aborted
        ? `Cancelled. ${written} of ${j.tasks.length} tasks were saved to Notion.`
        : failures
          ? `Finished with problems: ${written} of ${j.tasks.length} tasks saved. Press Retry failed to try the rest.`
          : `Done. All ${written} tasks are in Notion.`)
    })
  } catch (error) {
    const appError = AppError.from(error)
    await updateJob((j) => {
      j.status = appError.code === 'CANCELLED' ? 'cancelled' : 'error'
      j.finishedAt = Date.now()
      j.error = appError.toJSON()
      for (const step of j.steps) if (step.status === 'active') step.status = 'failed'
      appendLog(j, appError.message, 'error')
    })
  } finally {
    currentRun = null
    stopKeepAlive()
  }

  return readJob()
}

// --- message handling -----------------------------------------------------

const handlers = {
  async GET_JOB() {
    return { job: await readJob(), running: Boolean(currentRun) }
  },

  async START_JOB(payload) {
    if (currentRun) throw new AppError('ALREADY_RUNNING', 'A generation run is already in progress.')
    await preflight() // surfaces "Notion not connected" etc. as a normal reply

    // Deliberately NOT awaited: reply to the popup now, keep working after it
    // closes. Any late failure is written into the job for the popup to read.
    runJob(payload).catch(async (error) => {
      await updateJob((j) => {
        j.status = 'error'
        j.error = AppError.from(error).toJSON()
        appendLog(j, AppError.from(error).message, 'error')
      })
    })
    return { started: true }
  },

  /** Continue a run that was interrupted or partly failed, on the same page. */
  async RESUME_JOB() {
    if (currentRun) throw new AppError('ALREADY_RUNNING', 'A generation run is already in progress.')
    const job = await readJob()
    if (!job?.sourceTasks?.length) throw new AppError('NOTHING_TO_RESUME', 'There is no unfinished run to continue.')
    await preflight()

    runJob({
      tasks: job.sourceTasks,
      unit: job.unit,
      pageTitle: job.pageTitle,
      strategy: job.strategy,
      resumeJobId: job.id,
    }).catch(() => {})
    return { started: true }
  },

  async CANCEL_JOB() {
    if (!currentRun) {
      await updateJob((j) => { if (j.status === 'running') { j.status = 'cancelled'; j.finishedAt = Date.now() } })
      return { cancelled: true }
    }
    currentRun.abort.abort()
    return { cancelled: true }
  },

  /** `token` is only passed while testing a secret that is not saved yet. */
  async TEST_NOTION({ token } = {}) {
    const me = token ? await notion.me(token) : await withNotionAuth((t) => notion.me(t))
    return { ok: true, name: me?.name || me?.bot?.owner?.user?.name || 'your Notion connection' }
  },

  async LIST_NOTION_PAGES({ token, query } = {}) {
    const result = token
      ? await notion.searchPages(token, query || '')
      : await withNotionAuth((t) => notion.searchPages(t, query || ''))
    return {
      pages: (result.results || [])
        .map((page) => ({ id: page.id, title: pageTitle(page) || 'Untitled', url: page.url, icon: page.icon?.emoji || '' }))
        .filter((p) => p.id),
    }
  },

  /**
   * "Continue with Notion". Runs here rather than in the panel so that closing
   * the panel mid-flow cannot strand a half-finished authorisation.
   */
  async NOTION_CONNECT() {
    const config = await getConfig()
    // Signing in can easily take longer than Chrome's idle timeout for a
    // service worker, and a worker shut down mid-flow loses the state value.
    startKeepAlive()
    try {
      const auth = await authorize(resolveBackendUrl(config))
      // The pasted secret, if any, is left alone - resolveNotionToken now
      // prefers the OAuth token, and nothing was deleted without being asked.
      await setConfig({ notionAuth: auth })
      return { workspaceName: auth.workspaceName, workspaceIcon: auth.workspaceIcon, ownerName: auth.ownerName }
    } finally {
      if (!currentRun) stopKeepAlive()
    }
  },

  /**
   * Forget the credentials this extension holds. Nothing is deleted inside
   * Notion; access is revoked from the workspace's own Connections settings.
   */
  async NOTION_DISCONNECT({ forgetToken = false, forgetPage = true } = {}) {
    const patch = { notionAuth: null }
    if (forgetToken) patch.notionToken = ''
    if (forgetPage) { patch.notionParentId = ''; patch.notionParentTitle = '' }
    return { config: await setConfig(patch) }
  },

  /**
   * Make the destination page in Notion, so nobody has to leave the extension,
   * create a page by hand and share it with a connection.
   *
   * `parentPageId` is optional: without one the page is created at the top
   * level of the workspace, which Notion only permits for an OAuth connection.
   */
  async CREATE_NOTION_PAGE({ title, parentPageId = '' } = {}) {
    const name = String(title || '').trim()
    if (!name) throw new AppError('NOTION_PAGE_NAME_REQUIRED', 'Give the page a name first.')

    const config = await getConfig()
    if (!parentPageId && notionAuthMethod(config) !== 'oauth') {
      throw new AppError('NOTION_CANNOT_CREATE_TOP_LEVEL',
        'An integration secret cannot create a page at the top level of your workspace — only signing in with Notion can. Choose an existing page instead, or press "Continue with Notion".')
    }

    const page = await withNotionAuth((token) => createDestinationPage(token, name, { parentPageId }))
    // Selecting it is the whole point: the next screen is Generate.
    await setConfig({ notionParentId: page.id, notionParentTitle: name })
    return { id: page.id, title: name, url: page.url || null }
  },

  /**
   * Facts the Notion tab needs to describe itself. Deliberately touches no
   * network: probing the sign-in server on every render is what turned a
   * developer's stopped backend into the first thing a user saw.
   */
  async NOTION_SETUP_INFO() {
    const config = await getConfig()
    const backendUrl = resolveBackendUrl(config)
    return {
      redirectUri: redirectUri(),
      backendUrl,
      // A user of a released build must never be told to start a server.
      development: IS_DEV_BUILD,
      overridden: backendUrl !== DEFAULT_BACKEND_URL,
    }
  },

  /** Does a page with this title already exist? Drives the duplicate prompt. */
  async CHECK_EXISTING_PAGE({ title }) {
    const config = await getConfig()
    if (!resolveNotionToken(config) || !config.notionParentId) return { exists: false }
    const existing = await withNotionAuth((token) => findExistingPage(token, config.notionParentId, title))
    return { exists: Boolean(existing), pageId: existing?.id || null }
  },

  /**
   * Really calls the selected provider with the entered base URL, model and key.
   * `overrides` lets the Options page test what is on screen before saving.
   */
  async TEST_AI({ overrides } = {}) {
    const stored = await getConfig()
    const config = overrides
      ? { ...stored, ai: { ...stored.ai, ...overrides, providers: { ...stored.ai.providers, ...(overrides.providers || {}) } } }
      : stored
    const provider = getProvider(config)
    // Same policy as note generation: a transient failure (a cold OpenRouter
    // model answering 5xx, a Render service still waking up) is retried
    // before anything is shown. Permanent errors surface at once.
    const result = await retryTransient(() => provider.testConnection(), {
      delays: provider.mode === 'backend' ? BACKEND_RETRY_DELAYS : DIRECT_RETRY_DELAYS,
    })
    return {
      ok: true,
      provider: provider.resolved.label,
      model: provider.resolved.model,
      mode: provider.mode,
      description: provider.describe(),
      reply: result.reply || '',
    }
  },

  /** The active provider, for the popup's status line. Never throws. */
  async DESCRIBE_AI() {
    try {
      const provider = getProvider(await getConfig())
      return {
        ok: true,
        description: provider.describe(),
        label: provider.resolved.label,
        model: provider.resolved.model,
        mode: provider.mode,
      }
    } catch (error) {
      return { ok: false, message: AppError.from(error).message }
    }
  },

  async SAVE_CONFIG({ patch }) {
    return { config: await setConfig(patch) }
  },

  /** Change one provider's settings without touching any other provider's. */
  async SAVE_PROVIDER_CONFIG({ providerId, patch }) {
    return { config: await setProviderConfig(providerId, patch) }
  },
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type]
  if (!handler) return false

  handler(message.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: AppError.from(error).toJSON() }))

  return true // keeps the message channel open for the async reply
})
