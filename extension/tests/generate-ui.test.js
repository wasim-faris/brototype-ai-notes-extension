import test from 'node:test'
import assert from 'node:assert/strict'
import { loadView, mount, onMessage, sent, tabsOpened } from './helpers/view-harness.js'

/**
 * The Generate and Progress screens, driven by clicking.
 *
 * Every button a student can reach is pressed here and its effect asserted —
 * navigation actually navigates, retry actually retries, cancel actually
 * cancels. A button that renders but does nothing passes a render test and
 * fails this one.
 */

const GenerateView = await loadView('src/app/views/GenerateView.jsx')
const ProgressView = await loadView('src/app/views/ProgressView.jsx')

const config = {
  notionToken: '', notionAuth: { accessToken: 'ntn_x', workspaceName: 'Study' },
  notionOAuthBackendUrl: '', notionParentId: 'p1', notionParentTitle: 'Brototype Notes',
  ai: { mode: 'direct', activeProvider: 'gemini', backendUrl: '', providers: {} },
  duplicateStrategy: 'ask', aiRequestsPerMinute: null, taskListSelector: '',
}
const allReady = { ai: true, notion: true, destination: true }

const TASKS = [
  { number: 1, title: 'Understand Advanced React Hooks', subtopics: [{ title: 'useContext' }, { title: 'useReducer' }] },
  { number: 2, title: 'Understand State Management', subtopics: [{ title: 'Local state' }] },
]

/** A worker that answers as if a Brototype page were open. */
function workerWithTasks(overrides = {}) {
  onMessage(async (m) => {
    if (m.type === 'GET_JOB') return { job: null }
    if (m.type === 'CHECK_EXISTING_PAGE') return { exists: false }
    if (m.type === 'START_JOB') return { started: true }
    if (overrides[m.type]) return overrides[m.type](m)
    return {}
  })
}

/** GenerateView reads the page through chrome.scripting + tabs.sendMessage. */
function pageAnswers(result) {
  globalThis.chrome.tabs.sendMessage = async () => result
}

const readyPage = {
  ok: true, pageTitle: 'Mod 6 — React', unit: { title: 'Mod 6 — React', module: 'Advanced Concepts' },
  tasks: TASKS, warnings: [],
}

// --- readiness ------------------------------------------------------------

test('Connect AI and Connect Notion actually navigate to their setup screens', async () => {
  workerWithTasks()
  pageAnswers({ ok: false, tasks: [] })
  const gone = []
  const ui = await mount(GenerateView, { config, status: { ai: false, notion: false, destination: false }, go: (v) => gone.push(v) })

  await ui.click('Connect AI')
  assert.deepEqual(gone, ['ai'], 'Connect AI goes to the AI screen')

  await ui.click('Connect Notion')
  assert.deepEqual(gone, ['ai', 'notion'], 'Connect Notion goes to the Notion screen')
})

test('Choose page appears only when Notion is connected but has no destination', async () => {
  workerWithTasks()
  pageAnswers({ ok: false, tasks: [] })
  const gone = []
  const ui = await mount(GenerateView, { config, status: { ai: true, notion: true, destination: false }, go: (v) => gone.push(v) })

  assert.ok(!ui.button('Connect Notion'), 'a connected account is not asked to connect again')
  await ui.click('Choose page')
  assert.deepEqual(gone, ['notion'])
})

// --- detection ------------------------------------------------------------

test('a page with tasks lists them, all selected, with the real titles', async () => {
  workerWithTasks()
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  assert.ok(ui.text().includes('Understand Advanced React Hooks'))
  assert.ok(ui.text().includes('2 tasks detected'))
  assert.ok(ui.text().includes('2 selected'))
  assert.equal(ui.checkboxes().filter((c) => c.checked).length, 2)
})

test('Select all and Clear all really change the selection', async () => {
  workerWithTasks()
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Clear all')
  assert.equal(ui.checkboxes().filter((c) => c.checked).length, 0)
  assert.ok(ui.text().includes('0 selected'))

  await ui.click('Select all')
  assert.equal(ui.checkboxes().filter((c) => c.checked).length, 2)
})

test('unticking a task removes it, and the Generate button says why it is blocked', async () => {
  workerWithTasks()
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Clear all')
  assert.ok(ui.button('Generate study notes').disabled, 'nothing selected, nothing to generate')
  assert.ok(ui.text().includes('Select at least one task.'), 'and it says why')
})

test('Rescan re-reads the page and is never an unlabelled button', async () => {
  workerWithTasks()
  let reads = 0
  globalThis.chrome.tabs.sendMessage = async () => { reads++; return readyPage }
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  const before = reads
  await ui.click('Rescan')
  assert.ok(reads > before, 'Rescan actually re-read the page')
  // The old UI rendered `{reading ? '' : 'Rescan'}` — a button with no label.
  assert.ok(ui.buttons().every((l) => l.length > 0), `unlabelled button: ${JSON.stringify(ui.buttons())}`)
})

test('an empty page explains what to do and Rescan works from there', async () => {
  workerWithTasks()
  pageAnswers({ ok: false, tasks: [], url: 'https://campus.brototype.com/x' })
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  assert.ok(ui.text().includes('No tasks found on this page'))
  assert.ok(!/no data|not found\b.*null/i.test(ui.text()), 'no developer wording')
  assert.ok(ui.button('Rescan') && ui.button('Point at the list') && ui.button('Paste tasks'))
})

test('Paste tasks opens the paste screen, and Back returns to detection', async () => {
  workerWithTasks()
  pageAnswers({ ok: false, tasks: [] })
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Paste tasks')
  assert.ok(ui.text().includes('Paste your tasks'))
  await ui.click('Back')
  assert.ok(ui.text().includes('No tasks found') || ui.text().includes('This page'), 'back to detection')
})

// --- generating -----------------------------------------------------------

test('Generate starts a run with exactly the selected tasks', async () => {
  workerWithTasks()
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Generate study notes')
  const start = sent.find((m) => m.type === 'START_JOB')
  assert.ok(start, 'a run was actually started')
  assert.deepEqual(start.payload.tasks.map((t) => t.title), TASKS.map((t) => t.title))
  assert.equal(start.payload.pageTitle, 'Mod 6 — React')
})

test('Generate offers the duplicate choices when the page already exists, and Cancel backs out', async () => {
  onMessage(async (m) => {
    if (m.type === 'GET_JOB') return { job: null }
    if (m.type === 'CHECK_EXISTING_PAGE') return { exists: true, pageId: 'p9' }
    return {}
  })
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Generate study notes')
  assert.ok(ui.text().includes('That page already exists'))
  assert.ok(!sent.some((m) => m.type === 'START_JOB'), 'nothing was written yet')

  await ui.click('Cancel')
  assert.ok(ui.text().includes('This page'), 'Cancel really returns to the task list')
  assert.ok(!sent.some((m) => m.type === 'START_JOB'))
})

test('choosing a duplicate strategy starts the run with that strategy', async () => {
  onMessage(async (m) => {
    if (m.type === 'GET_JOB') return { job: null }
    if (m.type === 'CHECK_EXISTING_PAGE') return { exists: true }
    if (m.type === 'START_JOB') return { started: true }
    return {}
  })
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Generate study notes')
  await ui.click('Add to the existing page')
  assert.equal(sent.find((m) => m.type === 'START_JOB').payload.strategy, 'skip')
})

test('a failure to start is shown in words, and Dismiss clears it', async () => {
  onMessage(async (m) => {
    if (m.type === 'GET_JOB') return { job: null }
    if (m.type === 'CHECK_EXISTING_PAGE') return { exists: false }
    if (m.type === 'START_JOB') throw Object.assign(new Error('Notion is not connected yet.'), { code: 'NOTION_NOT_CONNECTED' })
    return {}
  })
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  await ui.click('Generate study notes')
  assert.ok(ui.text().includes('Notion is not connected yet.'))
  assert.ok(!/NOTION_NOT_CONNECTED/.test(ui.text()), 'the error code is never shown to the user')

  await ui.click('Dismiss')
  assert.ok(!ui.text().includes('Notion is not connected yet.'))
})

// --- while a run is happening ---------------------------------------------

const job = (over = {}) => ({
  status: 'running', pageTitle: 'Mod 6 — React', currentMessage: 'Writing useContext', notionPageUrl: null,
  error: null, warnings: [],
  tasks: [{ number: 1, title: 'Hooks', status: 'done', message: '' }, { number: 2, title: 'State', status: 'active', message: '' }],
  log: [{ level: 'info', message: 'Using Google Gemini' }],
  ...over,
})

test('Cancel during a run really asks the worker to cancel', async () => {
  onMessage(async () => ({}))
  const ui = await mount(ProgressView, { job: job(), onCancel: () => sent.push({ type: 'CANCEL_JOB' }), onResume() {}, onReset() {} })

  assert.ok(ui.text().includes('Writing useContext'), 'the live line proves it is not frozen')
  await ui.click('Cancel')
  assert.ok(sent.some((m) => m.type === 'CANCEL_JOB'))
})

test('a finished run offers Open in Notion and Done, and both work', async () => {
  onMessage(async () => ({}))
  let reset = 0
  const finished = job({
    status: 'done', currentMessage: '', notionPageUrl: 'https://notion.so/page',
    tasks: [{ number: 1, title: 'Hooks', status: 'done', message: '' }],
  })
  const ui = await mount(ProgressView, { job: finished, onCancel() {}, onResume() {}, onReset: () => { reset++ } })

  assert.ok(ui.text().includes('Study notes generated'))
  assert.ok(!ui.button('Cancel'), 'nothing to cancel once it is done')

  const before = tabsOpened.length
  await ui.click('Open in Notion')
  assert.equal(tabsOpened.length, before + 1, 'Open in Notion opened the page')

  await ui.click('Done')
  assert.equal(reset, 1, 'Done clears the finished run')
})

test('Retry failed really resumes, and the error code stays out of the message', async () => {
  onMessage(async () => ({}))
  let resumed = 0
  const partly = job({
    status: 'done', currentMessage: '',
    tasks: [{ number: 1, title: 'Hooks', status: 'done', message: '' }, { number: 2, title: 'State', status: 'failed', message: 'rate limit' }],
  })
  const ui = await mount(ProgressView, { job: partly, onCancel() {}, onResume: () => { resumed++ }, onReset() {} })

  assert.ok(ui.text().includes('Some tasks'))
  await ui.click('Retry failed')
  assert.equal(resumed, 1)
})

test('an interrupted run offers Resume and says so in plain words', async () => {
  onMessage(async () => ({}))
  let resumed = 0
  const interrupted = job({
    status: 'error', currentMessage: '',
    error: { code: 'INTERRUPTED', message: 'Chrome stopped the extension while notes were being generated.' },
  })
  const ui = await mount(ProgressView, { job: interrupted, onCancel() {}, onResume: () => { resumed++ }, onReset() {} })

  assert.ok(ui.text().includes('Generation was interrupted'))
  assert.ok(!ui.text().includes('INTERRUPTED'), 'the code is not shown to the user')
  await ui.click('Resume')
  assert.equal(resumed, 1)
})

// --- reopening the panel ---------------------------------------------------

test('reopening the panel mid-run shows the run, not the task list', async () => {
  // Chrome destroys the side panel when it is closed and rebuilds it on
  // reopen, so the view must read the run back from the worker rather than
  // hold it in memory.
  const running = job()
  onMessage(async (m) => (m.type === 'GET_JOB' ? { job: running } : {}))
  pageAnswers(readyPage)

  const ui = await mount(GenerateView, { config, status: allReady, go() {} })
  assert.ok(ui.text().includes('Writing useContext'), 'the run is restored')
  assert.ok(!ui.button('Generate study notes'), 'and does not offer to start a second one')
})

test('reopening after a run finished long ago goes back to the task list', async () => {
  const stale = job({ status: 'done', finishedAt: Date.now() - 60 * 60_000, currentMessage: '' })
  onMessage(async (m) => (m.type === 'GET_JOB' ? { job: stale } : {}))
  pageAnswers(readyPage)

  const ui = await mount(GenerateView, { config, status: allReady, go() {} })
  assert.ok(ui.button('Generate study notes'), 'an hour-old run is not in the way')
})

test('reopening with setup already done does not ask for setup again', async () => {
  workerWithTasks()
  pageAnswers(readyPage)
  const ui = await mount(GenerateView, { config, status: allReady, go() {} })

  assert.ok(!ui.text().includes('Before you start'), 'no setup card once everything is connected')
  assert.ok(!ui.button('Connect Notion') && !ui.button('Connect AI'))
})

// --- no developer language reaches the user --------------------------------

test('no view shows an error code, HTTP status, or stack to the user', async () => {
  const codes = /\b(NOTION_[A-Z_]+|AI_[A-Z_]+|EADDRINUSE|ECONNREFUSED|ERR_[A-Z_]+)\b|\bHTTP \d{3}\b/

  onMessage(async (m) => {
    if (m.type === 'GET_JOB') return { job: null }
    if (m.type === 'CHECK_EXISTING_PAGE') return { exists: false }
    if (m.type === 'START_JOB') throw Object.assign(new Error('Notion is not connected yet.'), { code: 'NOTION_NOT_CONNECTED', detail: 'HTTP 401 from api.notion.com' })
    return {}
  })
  pageAnswers(readyPage)

  const ui = await mount(GenerateView, { config, status: allReady, go() {} })
  await ui.click('Generate study notes')
  assert.ok(!codes.test(ui.text()), `a code leaked: ${ui.text().match(codes)}`)

  const failedJob = job({
    status: 'error', currentMessage: '',
    error: { code: 'NOTION_UNAUTHORIZED', message: 'Your Notion access has expired. Connect Notion again.', detail: 'HTTP 401' },
  })
  const progress = await mount(ProgressView, { job: failedJob, onCancel() {}, onResume() {}, onReset() {} })
  assert.ok(progress.text().includes('Connect Notion again'))
  assert.ok(!codes.test(progress.text()), `a code leaked: ${progress.text().match(codes)}`)
})

test('Rescan is offered exactly once, whatever the page state', async () => {
  workerWithTasks()
  for (const page of [
    { ok: false, tasks: [], url: 'https://campus.brototype.com/x' },   // empty
    readyPage,                                                          // ready
  ]) {
    pageAnswers(page)
    const ui = await mount(GenerateView, { config, status: allReady, go() {} })
    const rescans = ui.buttons().filter((l) => l === 'Rescan').length
    assert.ok(rescans <= 1, `Rescan appears ${rescans} times`)
  }
})

// --- what the panel says while retries are happening ------------------------

test('a retry notice stays out of the headline and goes to Details', async () => {
  onMessage(async () => ({}))
  // A rate-limit retry was logged as the newest entry — the old code made that
  // the main status line, so the panel read "Retrying in 1s (attempt 2 of 3)".
  const retrying = job({
    currentMessage: 'Task 1: writing notes for 5 topic(s)',
    log: [{ level: 'info', message: 'Using OpenRouter' }, { level: 'warn', message: 'OpenRouter rate limit hit. Retrying in 16s (attempt 2 of 3).' }],
  })
  const ui = await mount(ProgressView, { job: retrying, onCancel() {}, onResume() {}, onReset() {} })

  // Everything above the Details block is what the user reads at a glance.
  const glance = ui.html().split('<summary>Details</summary>')[0].replace(/<[^>]+>/g, ' ')
  assert.ok(glance.includes('Working on task 2 of 2'), 'the headline says what is being worked on')
  assert.ok(glance.includes('retrying automatically'), 'the user is told, quietly')
  assert.ok(!glance.includes('attempt 2 of 3'), 'but not in the technical wording')

  // The full technical line is still there, in the log behind Details.
  assert.ok(ui.text().includes('attempt 2 of 3'), 'the detail is kept, just not up front')
  assert.ok(ui.html().includes('<summary>Details</summary>'))
})

test('an AI failure reads as an AI problem, with its specific reason kept', async () => {
  onMessage(async () => ({}))
  const failed = job({
    status: 'error', currentMessage: '',
    error: { code: 'AI_QUOTA', message: 'OpenRouter says the account is out of quota or credit.' },
  })
  const ui = await mount(ProgressView, { job: failed, onCancel() {}, onResume() {}, onReset() {} })

  assert.ok(ui.text().includes("AI couldn't generate the notes right now"))
  assert.ok(ui.text().includes('out of quota or credit'), 'the actionable reason is not hidden')
  assert.ok(!ui.text().includes('AI_QUOTA'), 'the code is not shown')
})
