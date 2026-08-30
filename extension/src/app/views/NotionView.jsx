import { useEffect, useState } from 'react'
import { maskSecret, notionAuthMethod } from '../../lib/storage.js'
import { send } from '../../ui/messaging.js'
import { IS_DEV_BUILD } from '../../lib/env.js'
import { Panel, Callout, Empty, Secret, Spinner } from '../../ui/components.jsx'

/** Failures that are the sign-in service's fault, not the user's. */
const SERVICE_ERRORS = ['NOTION_SERVICE_UNAVAILABLE', 'NOTION_OAUTH_BACKEND_ERROR', 'NOTION_OAUTH_NOT_CONFIGURED']

/**
 * Notion, as two questions:
 *
 *   1. is your account connected?        → Continue with Notion
 *   2. where should the notes be saved?  → create one, or pick one
 *
 * Everything a normal student never needs to know — tokens, redirect URLs, the
 * sign-in server — lives under Advanced and nowhere else.
 */
export default function NotionView({ config, update, go }) {
  const method = notionAuthMethod(config)          // 'oauth' | 'token' | 'none'
  const connected = method !== 'none'
  const hasPage = Boolean(config.notionParentId)

  const [connect, setConnect] = useState({ state: 'idle' })   // idle | connecting | error
  const [setup, setSetup] = useState(null)                    // NOTION_SETUP_INFO, no network
  const [advanced, setAdvanced] = useState(false)
  const [draftToken, setDraftToken] = useState('')
  const [tokenTest, setTokenTest] = useState({ state: 'idle' })

  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(null)
  const [loadingPages, setLoadingPages] = useState(false)
  const [pagesError, setPagesError] = useState(null)

  const [destination, setDestination] = useState('choose')    // choose | create | select
  const [newPageName, setNewPageName] = useState('Brototype Notes')
  const [creating, setCreating] = useState({ state: 'idle' }) // idle | busy | err
  const [created, setCreated] = useState(null)
  // Set by "Change": lets the chooser reappear over an existing destination,
  // so backing out leaves the current one still selected.
  const [changing, setChanging] = useState(false)

  useEffect(() => {
    let live = true
    send('NOTION_SETUP_INFO').then((s) => live && setSetup(s)).catch(() => {})
    return () => { live = false }
  }, [])

  const startOAuth = async () => {
    setConnect({ state: 'connecting' })
    try {
      await send('NOTION_CONNECT')
      setConnect({ state: 'idle' })
      setDestination('choose')                      // where the notes go is the next question
    } catch (e) {
      setConnect({ state: 'error', code: e.code, message: e.message, detail: e.detail })
    }
  }

  const saveToken = async () => {
    const token = draftToken.trim()
    if (!token) return
    setTokenTest({ state: 'testing' })
    try {
      await send('TEST_NOTION', { token })
      await update({ notionToken: token })
      setDraftToken('')
      setTokenTest({ state: 'idle' })
    } catch (e) {
      setTokenTest({ state: 'err', message: e.message })
    }
  }

  /** No token argument: the worker uses whatever is stored, OAuth or pasted. */
  const loadPages = async (q = query, token) => {
    setLoadingPages(true)
    setPagesError(null)
    try {
      const { pages: found } = await send('LIST_NOTION_PAGES', { query: q, ...(token ? { token } : {}) })
      setPages(found)
    } catch (e) {
      setPagesError(e.message)
    } finally {
      setLoadingPages(false)
    }
  }

  const createPage = async () => {
    const title = newPageName.trim()
    if (!title) return
    setCreating({ state: 'busy' })
    try {
      const page = await send('CREATE_NOTION_PAGE', { title })
      setCreating({ state: 'idle' })
      setCreated(page)
      setPages(null)
      setChanging(false)
      // The worker wrote the selection to storage and App watches storage, so
      // the new destination arrives on its own.
    } catch (e) {
      setCreating({ state: 'err', message: e.message })
    }
  }

  const disconnect = async () => {
    if (!confirm('Disconnect Notion?\n\nThis only removes the connection from this extension. Nothing in your Notion workspace is deleted.')) return
    // A pasted secret is something the user typed and may not have kept
    // anywhere else, so it is only removed when that is what they disconnected.
    await send('NOTION_DISCONNECT', { forgetToken: method === 'token' })
    setPages(null)
    setQuery('')
    setDestination('choose')
    setCreated(null)
    setChanging(false)
    setConnect({ state: 'idle' })
    setTokenTest({ state: 'idle' })
  }

  const choose = async (page) => {
    await update({ notionParentId: page.id, notionParentTitle: page.title })
    setChanging(false)
  }

  const busy = connect.state === 'connecting'
  const failed = connect.state === 'error'
  const cancelled = failed && connect.code === 'NOTION_OAUTH_CANCELLED'
  const serviceDown = failed && SERVICE_ERRORS.includes(connect.code)
  const workspace = config.notionAuth?.workspaceName || ''
  // Notion allows a top-level page only for an OAuth connection, so an
  // integration secret never gets a button that cannot work.
  const canCreate = method === 'oauth'

  const connectError = failed && (
    cancelled ? (
      <Callout kind="warn" title="Sign-in cancelled" actions={<button onClick={startOAuth}>Try again</button>}>
        You closed the Notion window before approving. Nothing was changed.
      </Callout>
    ) : serviceDown ? (
      <Callout kind="err" title="Couldn't connect to Notion" actions={<button onClick={startOAuth}>Try again</button>}>
        We couldn't reach the Notion sign-in service right now. Check your connection and try again in a moment.
        {setup?.development && connect.detail && (
          <span className="tiny" style={{ display: 'block', marginTop: 6, opacity: .8 }}>
            Development build — start the local backend to enable Notion login. ({connect.detail})
          </span>
        )}
      </Callout>
    ) : (
      <Callout kind="err" title="Couldn't connect to Notion" actions={<button onClick={startOAuth}>Try again</button>}>
        {connect.message}
      </Callout>
    )
  )

  // --- not connected --------------------------------------------------------
  if (!connected) {
    return (
      <Panel title="Notion">
        <div className="row"><span className="dot bad" /><strong>Not connected</strong></div>
        <p className="small muted">Connect your Notion account to save your study notes.</p>

        <button className="primary big" onClick={startOAuth} disabled={busy}>
          {busy ? <><Spinner onAccent /> Waiting for Notion…</> : 'Continue with Notion'}
        </button>

        {busy && <p className="tiny muted" style={{ textAlign: 'center' }}>Sign in and choose the pages this extension may use.</p>}
        {connectError}

        <hr className="divider" />
        <details className="small" open={advanced} onToggle={(e) => setAdvanced(e.target.open)}>
          <summary>Advanced</summary>

          <div className="stack" style={{ marginTop: 10 }}>
            <span className="grouplabel">Integration secret</span>
            <p className="tiny muted">For development, or if you cannot use Notion sign-in. Create one at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a> and share your page with it.</p>
            <div className="input-row">
              <input type="password" autoComplete="off" placeholder="ntn_…" value={draftToken}
                     onChange={(e) => setDraftToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveToken()} />
              <button onClick={saveToken} disabled={!draftToken.trim() || tokenTest.state === 'testing'}>
                {tokenTest.state === 'testing' ? <><Spinner /> Checking</> : 'Use secret'}
              </button>
            </div>
            {tokenTest.state === 'err' && <Callout kind="err" title="Notion rejected that secret">{tokenTest.message}</Callout>}

            {IS_DEV_BUILD && (
              <>
                <span className="grouplabel" style={{ marginTop: 6 }}>Sign-in server</span>
                <input type="text" placeholder={setup?.backendUrl || ''} value={config.notionOAuthBackendUrl}
                       onChange={(e) => update({ notionOAuthBackendUrl: e.target.value })} />
                <p className="tiny muted">
                  Development builds only. Leave empty to use the server this build was made for{setup?.backendUrl ? <> (<code>{setup.backendUrl}</code>)</> : null}.
                </p>
              </>
            )}

            <span className="grouplabel" style={{ marginTop: 6 }}>Redirect URL</span>
            <code className="tiny truncate">{setup?.redirectUri || '…'}</code>
            <p className="tiny muted">Register this exact URL in the Notion integration's redirect URIs.</p>
          </div>
        </details>
      </Panel>
    )
  }

  // --- connected ------------------------------------------------------------
  return (
    <>
      <Panel title="Notion" right={<button className="quiet" onClick={disconnect}>Disconnect</button>}>
        <div className="row"><span className="dot ok" /><strong>Connected</strong></div>
        <p className="small muted">
          {method === 'oauth'
            ? <>Notion account connected successfully{workspace ? <> — {workspace}</> : null}.</>
            : <>Connected with an integration secret.</>}
        </p>

        {method === 'token' && (
          <>
            <Secret masked={maskSecret(config.notionToken)} onReplace={() => { setDraftToken(''); setAdvanced(true) }} onDelete={disconnect} />
            <div className="row">
              <span className="tiny muted grow">You can switch to signing in with Notion instead.</span>
              <button onClick={startOAuth} disabled={busy}>{busy ? <><Spinner /> Waiting…</> : 'Continue with Notion'}</button>
            </div>
            {connectError}
          </>
        )}
      </Panel>

      <Panel title="Where your notes are saved">
        {/* Rendered outside the branches below: the confirmation belongs to the
            action, not to whichever screen the config has caught up to. */}
        {created && (
          <Callout kind="ok" title="Page created">
            {created.title} is ready in Notion and selected as your destination.
            {created.url && <> <a href={created.url} target="_blank" rel="noreferrer">Open in Notion</a></>}
          </Callout>
        )}
        {hasPage && !changing ? (
          <>
            <div className="row">
              <span className="grow small">Saving into <strong>{config.notionParentTitle}</strong>.</span>
              <button className="quiet" onClick={() => { setChanging(true); setDestination('choose'); setCreated(null) }}>Change</button>
            </div>
            <button className="primary" onClick={() => go('generate')}>Go to Generate</button>
          </>
        ) : destination === 'choose' ? (
          <Empty
            title="No destination selected"
            actions={
              <>
                {canCreate && <button className="primary" onClick={() => setDestination('create')}>Create new page</button>}
                <button className={canCreate ? '' : 'primary'} onClick={() => { setDestination('select'); loadPages('') }}>
                  Choose existing page
                </button>
                {hasPage && <button className="quiet" onClick={() => setChanging(false)}>Keep {config.notionParentTitle}</button>}
              </>
            }
          >
            Choose where your study notes should be saved. Each set of notes becomes a page inside it.
          </Empty>
        ) : destination === 'create' ? (
          <>
            <div className="field">
              <span className="label">Page name</span>
              <input type="text" autoFocus placeholder="Brototype Notes" value={newPageName}
                     onChange={(e) => setNewPageName(e.target.value)}
                     onKeyDown={(e) => e.key === 'Enter' && createPage()} />
              <span className="hint">Created in your Notion workspace and selected automatically.</span>
            </div>
            <div className="row">
              <button className="primary" onClick={createPage} disabled={!newPageName.trim() || creating.state === 'busy'}>
                {creating.state === 'busy' ? <><Spinner onAccent /> Creating…</> : 'Create page'}
              </button>
              <button onClick={() => { setDestination('choose'); setCreating({ state: 'idle' }) }} disabled={creating.state === 'busy'}>Cancel</button>
            </div>
            {creating.state === 'err' && (
              <Callout kind="err" title="Couldn't create the page" actions={<>
                <button onClick={createPage}>Try again</button>
                <button onClick={() => { setDestination('select'); loadPages('') }}>Choose existing page</button>
              </>}>{creating.message}</Callout>
            )}
          </>
        ) : (
          <>
            <div className="input-row">
              <input type="text" placeholder="Search your Notion pages…" value={query}
                     onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadPages()} />
              <button className={pages ? '' : 'primary'} onClick={() => loadPages()} disabled={loadingPages}>
                {loadingPages ? <><Spinner /> Loading</> : 'Find pages'}
              </button>
            </div>

            {loadingPages && !pages && <p className="tiny muted">Loading your pages…</p>}

            {pagesError && (
              <Callout kind="err" title="Couldn't load your pages" actions={<button onClick={() => loadPages()}>Try again</button>}>
                {pagesError}
              </Callout>
            )}

            {pages && !pages.length && (
              <Callout kind="warn" title="No pages found"
                       actions={canCreate
                         ? <button onClick={() => setDestination('create')}>Create one instead</button>
                         : <button onClick={startOAuth}>Choose pages in Notion</button>}>
                {method === 'oauth'
                  ? 'This extension only sees the pages you ticked while signing in.'
                  : 'Your integration only sees pages you shared with it in Notion.'}
              </Callout>
            )}

            {pages?.length > 0 && (
              <div className="list pick">
                {pages.map((page) => (
                  <div className="item" key={page.id}>
                    <span className="grow truncate">{page.icon} {page.title}</span>
                    <button className="primary" onClick={() => choose(page)}>Use this</button>
                  </div>
                ))}
              </div>
            )}

            <button className="quiet" onClick={() => setDestination('choose')}>Back</button>
          </>
        )}
      </Panel>
    </>
  )
}
