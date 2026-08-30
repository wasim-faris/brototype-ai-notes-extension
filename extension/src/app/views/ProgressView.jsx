import { Panel, Callout, Spinner } from '../../ui/components.jsx'

const ICON = { done: '✓', failed: '✕', active: '', pending: '·', skipped: '–' }

/**
 * Pure view over the job object in chrome.storage. It holds no state of its
 * own, which is why closing the panel mid-run loses nothing and reopening it
 * shows the run exactly where it is.
 *
 * What a student needs at a glance: how far along, what is happening right
 * now, whether it worked. The raw log is one click away, not in the way.
 */
export default function ProgressView({ job, onCancel, onResume, onReset }) {
  const total = job.tasks.length
  const done = job.tasks.filter((t) => t.status === 'done').length
  const failed = job.tasks.filter((t) => t.status === 'failed')
  const active = job.tasks.find((t) => t.status === 'active')
  const running = job.status === 'running'
  const percent = total ? Math.round((done / total) * 100) : 0
  const finished = job.status === 'done' && !failed.length

  const tone = running ? 'active' : finished ? 'ok' : job.status === 'cancelled' ? 'idle' : 'bad'

  // The headline says what is being worked on; the fine-grained message ("↳ b.
  // Shared state") sits under it as proof the extension has not frozen. Retry
  // notices stay in the log rather than replacing either of them.
  const headline = running
    ? (active ? `Working on task ${active.number} of ${total}` : 'Generating your study notes…')
    : finished ? `All ${done} task${done === 1 ? '' : 's'} saved to Notion`
    : job.status === 'cancelled' ? `Stopped — ${done} of ${total} tasks were saved`
    : failed.length ? `${done} of ${total} saved · ${failed.length} need${failed.length === 1 ? 's' : ''} another try`
    : 'Stopped'

  // A retry just happened if the newest log line is a warning. Worth saying
  // quietly — silence during a 15s rate-limit wait looks like a hang.
  const retrying = running && job.log[job.log.length - 1]?.level === 'warn'
  const aiProblem = job.error && /^AI_/.test(job.error.code || '')

  const openInNotion = () => chrome.tabs.create({ url: job.notionPageUrl })

  return (
    <>
      <Panel title={job.pageTitle}>
        <div className="row small">
          {running && <Spinner />}
          <span className="grow truncate" style={{ fontWeight: 600 }}>{headline}</span>
          <span className="tiny muted">{percent}%</span>
        </div>
        <div className={`bar ${tone === 'ok' ? 'done' : tone === 'bad' ? 'err' : ''}`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {running && (job.currentMessage || retrying) && (
          <div className="tiny muted truncate">
            {retrying ? 'Taking a moment — retrying automatically…' : job.currentMessage}
          </div>
        )}

        {finished && (
          <Callout kind="ok" title="Study notes generated" actions={
            <>
              {job.notionPageUrl && <button className="primary" onClick={openInNotion}>Open in Notion</button>}
              <button onClick={onReset}>Done</button>
            </>
          }>
            Saved to {job.pageTitle}. Every task has its subtopics and reviewer questions.
          </Callout>
        )}

        {job.error && (
          <Callout
            kind="err"
            title={job.error.code === 'INTERRUPTED' ? 'Generation was interrupted'
              : aiProblem ? "AI couldn't generate the notes right now"
              : "Generation couldn't finish"}
            actions={<>
              {(job.error.code === 'INTERRUPTED' || failed.length > 0) && <button className="primary" onClick={onResume}>Resume</button>}
              <button onClick={onReset}>Back</button>
            </>}
          >
            {job.error.message}
            {aiProblem && <span className="tiny" style={{ display: 'block', marginTop: 4, opacity: .8 }}>Check your AI connection and try again. Full details are under Details below.</span>}
          </Callout>
        )}

        {Boolean(failed.length) && !job.error && (
          <Callout kind="warn" title="Some tasks didn't finish" actions={<button className="primary" onClick={onResume}>Retry failed</button>}>
            The finished tasks are already in Notion. Retrying redoes only the ones that failed.
          </Callout>
        )}

        {job.warnings.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>)}
      </Panel>

      <Panel title="Tasks">
        <div className="list">
          {job.tasks.map((task) => (
            <div className="item" key={task.number}>
              <span className="status-icon" style={{ color: task.status === 'done' ? 'var(--ok)' : task.status === 'failed' ? 'var(--err)' : 'var(--faint)' }}>
                {task.status === 'active' ? <span className="spinner" /> : ICON[task.status]}
              </span>
              <span className="num">{task.number}</span>
              <span className="grow">
                {task.title}
                {task.message && <div className="sub">{task.message}</div>}
              </span>
            </div>
          ))}
        </div>

        <details>
          <summary>Details</summary>
          <div className="log" style={{ marginTop: 8 }}>
            {job.log.slice(-80).map((entry, i) => <div key={i} className={entry.level}>{entry.message}</div>)}
          </div>
        </details>

        <div className="row wrap">
          {running && <button className="danger" onClick={onCancel}>Cancel</button>}
          {!running && !finished && <button onClick={onReset}>Back to tasks</button>}
          {!running && !finished && job.notionPageUrl && (
            <button className="quiet" onClick={openInNotion}>Open in Notion</button>
          )}
        </div>
      </Panel>
    </>
  )
}
