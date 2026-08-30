import { useCallback, useEffect, useRef, useState } from 'react'
import { send, extractTasksFromActiveTab, requestSiteAccess, startPicker, watchJob, watchActiveTab, watchConfig } from '../../ui/messaging.js'
import { describeAccessResult, hostOf, isBrototypeHost } from '../../ui/access.js'
import { Panel, Callout, Connection, Empty, Field, Spinner } from '../../ui/components.jsx'
import ProgressView from './ProgressView.jsx'
import ManualPaste from './ManualPaste.jsx'

/**
 * The main screen, in the order the question actually gets answered:
 *
 *   1. is anything missing?   → the setup card, only while something is
 *   2. what is on this page?  → detection, which re-runs on tab changes
 *   3. write the notes        → the one primary action
 *
 * Step 1 is at the top on purpose. Finding out that Notion is not connected by
 * pressing Generate and reading an error is the single worst moment in the old
 * flow, so the answer is on screen before the button is.
 */
export default function GenerateView({ config, status, go }) {
  const [job, setJob] = useState(null)
  const [read, setRead] = useState({ state: 'reading' })       // {state, tab?, message?, detail?, result?}
  const [access, setAccess] = useState(null)                   // {state, message, detail} after an Allow click
  const [mode, setMode] = useState('detect')                   // detect | paste | duplicate
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(null)
  const [pageTitle, setPageTitle] = useState('')
  const [selected, setSelected] = useState(new Set())

  // Refs so the tab-change listener never sees a stale job/mode.
  const jobRef = useRef(job); jobRef.current = job
  const modeRef = useRef(mode); modeRef.current = mode
  const selectorRef = useRef(config.taskListSelector); selectorRef.current = config.taskListSelector
  const readingRef = useRef(false)

  const detect = useCallback(async ({ silent = false } = {}) => {
    if (readingRef.current) return
    readingRef.current = true
    if (!silent) setRead((r) => ({ ...r, state: 'reading' }))
    try {
      const result = await extractTasksFromActiveTab(selectorRef.current || null)
      if (result.ok) {
        setRead({ state: 'ready', tab: { url: result.url, title: result.tabTitle }, result })
        setPageTitle(result.pageTitle || '')
        setSelected(new Set(result.tasks.map((t) => t.number)))
        setAccess(null) // access is obviously fine now; drop any old notice
      } else {
        setRead({ state: 'empty', tab: { url: result.url, title: result.tabTitle }, result })
      }
    } catch (e) {
      setRead({ state: e.code === 'NEEDS_ACCESS' ? 'needs-access' : ['BAD_PAGE', 'NO_TAB', 'NOT_BROTOTYPE'].includes(e.code) ? 'unsupported' : 'error', tab: e.tab, message: e.message, detail: e.detail, code: e.code })
    } finally {
      readingRef.current = false
    }
  }, [])

  useEffect(() => {
    (async () => {
      // Reopening the panel picks the run back up rather than starting over.
      const { job: existing } = await send('GET_JOB')
      const recent = existing && (existing.status === 'running' || Date.now() - (existing.finishedAt || 0) < 10 * 60_000)
      if (recent) setJob(existing)
      await detect()
    })().catch((e) => setRead({ state: 'error', message: e.message }))

    const stops = [
      watchJob(setJob),
      watchActiveTab(() => { if (!jobRef.current && modeRef.current === 'detect') detect({ silent: true }) }),
      watchConfig((next) => { if (next?.taskListSelector && next.taskListSelector !== selectorRef.current) detect() }),
    ]
    return () => stops.forEach((s) => s())
  }, [detect])

  /**
   * The Allow button. chrome.permissions.request needs a user gesture, so the
   * request is the FIRST thing that runs - no await before it.
   */
  const allowAndRead = (url) => {
    setAccess({ state: 'requesting', message: 'Waiting for Chrome…' })
    requestSiteAccess(url).then(async (outcome) => {
      const described = describeAccessResult(outcome, url)
      setAccess(described)
      if (described.state === 'granted') {
        setRead((r) => ({ ...r, state: 'reading' }))
        await detect()
      }
    })
  }

  // --- a run is happening or just finished ----------------------------------
  if (job) {
    return (
      <ProgressView
        job={job}
        onCancel={() => send('CANCEL_JOB')}
        onResume={() => send('RESUME_JOB').catch((e) => setStartError(e))}
        onReset={async () => { await chrome.storage.local.remove('job'); setJob(null); await detect() }}
      />
    )
  }

  if (mode === 'paste') {
    return (
      <ManualPaste
        onCancel={() => setMode('detect')}
        onUse={(tasks) => {
          setRead({ state: 'ready', tab: read.tab, result: { ok: true, source: 'manual', unit: { title: 'Brototype Tasks' }, pageTitle: pageTitle || 'Brototype Tasks', tasks, warnings: [] } })
          setSelected(new Set(tasks.map((t) => t.number)))
          setMode('detect')
        }}
      />
    )
  }

  const result = read.state === 'ready' ? read.result : null
  const tasks = result?.tasks || []
  const chosen = tasks.filter((t) => selected.has(t.number))
  const setupDone = status.ai && status.notion && status.destination
  const ready = setupDone && chosen.length > 0 && pageTitle.trim()

  const start = async (strategy) => {
    setStarting(true)
    setStartError(null)
    try {
      if (strategy === undefined) {
        const { exists } = await send('CHECK_EXISTING_PAGE', { title: pageTitle.trim() })
        if (exists && config.duplicateStrategy === 'ask') { setMode('duplicate'); return }
      }
      await send('START_JOB', { tasks: chosen, unit: result.unit, pageTitle: pageTitle.trim(), strategy: strategy ?? config.duplicateStrategy })
      setMode('detect')
    } catch (e) {
      setStartError(e)
      setMode('detect')
    } finally {
      setStarting(false)
    }
  }

  if (mode === 'duplicate') {
    return (
      <Panel title="That page already exists">
        <p className="small muted">“{pageTitle}” is already in Notion. Nothing is removed unless you choose it.</p>
        <div className="stack">
          <button className="primary" onClick={() => start('new')}>Create a second version</button>
          <button onClick={() => start('skip')}>Add to the existing page</button>
          <button className="danger" onClick={() => start('update')}>Replace what is there</button>
          <button className="quiet" onClick={() => setMode('detect')}>Cancel</button>
        </div>
      </Panel>
    )
  }

  const host = hostOf(read.tab?.url)
  const allSelected = tasks.length > 0 && selected.size === tasks.length
  const reading = read.state === 'reading'
  // These states put Rescan in the body as their primary action, so the
  // header must not offer a second one beside it.
  const bodyOffersRescan = ['empty', 'unsupported', 'error'].includes(read.state)

  /** The reason Generate cannot run yet, in the order the user should fix it. */
  const blockedBy =
    !status.ai ? 'Connect an AI provider to write the notes.'
    : !status.notion ? 'Connect Notion to save the notes.'
    : !status.destination ? 'Choose where in Notion the notes should be saved.'
    : read.state !== 'ready' ? 'Open a Brototype task page to get started.'
    : !chosen.length ? 'Select at least one task.'
    : !pageTitle.trim() ? 'Give the Notion page a name.'
    : ''

  return (
    <>
      {/* --- 1. what is missing, before anything is attempted ---------------- */}
      {!setupDone && (
        <Panel title="Before you start">
          <Connection
            state={status.ai ? 'ok' : 'bad'}
            name="AI"
            note={status.ai ? 'Connected' : 'Connect an AI provider to write your notes.'}
            action={!status.ai && <button className="primary" onClick={() => go('ai')}>Connect AI</button>}
          />
          <Connection
            state={status.notion ? (status.destination ? 'ok' : 'warn') : 'bad'}
            name="Notion"
            note={!status.notion ? 'Connect Notion to save your study notes.'
              : !status.destination ? 'Connected — choose where your notes should be saved.'
              : 'Connected'}
            action={!status.notion
              ? <button className="primary" onClick={() => go('notion')}>Connect Notion</button>
              : !status.destination
                ? <button className="primary" onClick={() => go('notion')}>Choose page</button>
                : null}
          />
        </Panel>
      )}

      {/* --- 2. this page ---------------------------------------------------- */}
      <Panel
        title="This page"
        right={!bodyOffersRescan && (
          <button className="quiet" onClick={() => detect()} disabled={reading}>
            {reading ? <><Spinner /> Checking</> : 'Rescan'}
          </button>
        )}
      >
        {reading && read.state !== 'ready' && (
          <div className="row muted small"><Spinner /> Checking {host || 'the page'}…</div>
        )}

        {read.state === 'needs-access' && (
          <Empty
            title="Let the extension read this page"
            actions={
              <button className="primary big" disabled={access?.state === 'requesting'} onClick={() => allowAndRead(read.tab?.url)}>
                {access?.state === 'requesting'
                  ? <><Spinner onAccent /> Waiting for Chrome…</>
                  : access?.state ? 'Try again' : 'Allow and read tasks'}
              </button>
            }
          >
            Chrome asks once for <strong>{host}</strong>, then remembers.
          </Empty>
        )}
        {read.state === 'needs-access' && access?.state === 'denied' && (
          <Callout kind="warn" title="Not allowed yet">{access.message}</Callout>
        )}
        {read.state === 'needs-access' && access?.state === 'error' && (
          <Callout kind="err" title="Chrome could not ask for access">
            {access.message} You can also allow it by hand from the extensions page.
          </Callout>
        )}

        {read.state === 'unsupported' && (
          <Empty title="No task page open" actions={<button className="primary" onClick={() => detect()}>Rescan</button>}>
            {read.code === 'NO_TAB'
              ? 'No web page is open in this window.'
              : 'Open a Brototype task page and the tasks appear here automatically.'}
          </Empty>
        )}

        {read.state === 'empty' && (
          <Empty
            title="No tasks found on this page"
            actions={
              <>
                <button className="primary" onClick={() => detect()}>Rescan</button>
                <button onClick={startPicker}>Point at the list</button>
                <button className="quiet" onClick={() => setMode('paste')}>Paste tasks</button>
              </>
            }
          >
            {isBrototypeHost(read.tab?.url)
              ? 'This looks like Brototype, but no numbered task list was found. Open the task page, or point at the list once and it will be remembered.'
              : `This is ${host}. Open a Brototype task page to get started.`}
          </Empty>
        )}

        {read.state === 'error' && (
          <Empty
            title="Couldn't read this page"
            actions={
              <>
                <button className="primary" onClick={() => detect()}>Try again</button>
                <button onClick={() => setMode('paste')}>Paste tasks instead</button>
              </>
            }
          >
            {read.message}
          </Empty>
        )}

        {read.state === 'ready' && (
          <>
            <div className="between">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {[result.unit?.title, result.unit?.module].filter(Boolean).join(' · ') || host}
                </div>
                <div className="tiny muted">
                  {tasks.length} task{tasks.length === 1 ? '' : 's'} detected · {selected.size} selected
                </div>
              </div>
              <button className="quiet" onClick={() => setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.number)))}>
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>

            {result.warnings?.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>)}

            <div className="list compact">
              {tasks.map((task) => (
                <label className={`item ${selected.has(task.number) ? '' : 'off'}`} key={task.number}>
                  <input type="checkbox" checked={selected.has(task.number)} onChange={() => {
                    const next = new Set(selected)
                    next.has(task.number) ? next.delete(task.number) : next.add(task.number)
                    setSelected(next)
                  }} />
                  <span className="num">{task.number}</span>
                  <span className="grow">
                    <span className="truncate" style={{ display: 'block' }}>{task.title}</span>
                    <span className="sub">{task.subtopics.length ? `${task.subtopics.length} topics` : 'title only'}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="row">
              <button className="quiet" onClick={startPicker}>Wrong list?</button>
              <button className="quiet" onClick={() => setMode('paste')}>Paste tasks</button>
            </div>
          </>
        )}
      </Panel>

      {/* --- 3. the one action ----------------------------------------------- */}
      {read.state === 'ready' && (
        <Panel title="Generate">
          <Field label="Notion page name" hint={config.notionParentTitle ? `Saved inside ${config.notionParentTitle}` : undefined}>
            <input type="text" value={pageTitle} onChange={(e) => setPageTitle(e.target.value)} />
          </Field>

          {startError && (
            <Callout kind="err" title="Couldn't start" actions={<button onClick={() => setStartError(null)}>Dismiss</button>}>
              {startError.message}
            </Callout>
          )}

          <button className="primary big" disabled={!ready || starting} onClick={() => start()}>
            {starting ? <><Spinner onAccent /> Starting…</> : 'Generate study notes'}
          </button>

          <p className="tiny muted" style={{ textAlign: 'center' }}>
            {blockedBy || 'Runs in the background — you can close this panel.'}
          </p>
        </Panel>
      )}
    </>
  )
}
