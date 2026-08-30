/** Small presentational pieces shared across the app. No logic lives here. */

export function Panel({ title, right, children }) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <h2>{title}</h2>
          {right}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  )
}

/**
 * A message with a heading, an explanation and a way forward.
 *
 * The rule for every one of these: say what happened, then what to do. A
 * message with no action is only acceptable when there is genuinely nothing to
 * do but read it.
 */
export function Callout({ kind = 'info', title, children, actions }) {
  return (
    <div className={`callout ${kind}`} role={kind === 'err' ? 'alert' : undefined}>
      {title && <span className="title">{title}</span>}
      {children && <span>{children}</span>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

/**
 * One service and whether it is ready — the Generate screen's readiness block.
 * state: ok | warn | bad | active
 */
export function Connection({ state, name, note, action }) {
  return (
    <div className="conn">
      <span className={`dot ${state}`} />
      <div className="body">
        <span className="name">{name}</span>
        {note && <span className={`note ${state === 'ok' ? 'ok' : ''}`}>{note}</span>}
      </div>
      {action}
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

/**
 * An empty state: never "no data". It names what is missing, why, and the one
 * or two things that would fix it.
 */
export function Empty({ title, children, actions }) {
  return (
    <div className="empty">
      <span className="title">{title}</span>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

/** A saved secret, never redisplayed in full. */
export function Secret({ masked, onReplace, onDelete }) {
  return (
    <div className="secret">
      <code className="grow truncate">{masked}</code>
      <button className="quiet" onClick={onReplace}>Replace</button>
      <button className="quiet" style={{ color: 'var(--err)' }} onClick={onDelete}>Remove</button>
    </div>
  )
}

export function Spinner({ onAccent }) {
  return <span className={`spinner${onAccent ? ' onaccent' : ''}`} aria-label="loading" />
}
