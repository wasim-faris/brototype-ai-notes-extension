import { useCallback, useEffect, useState } from 'react'
import { getConfig, resolveNotionToken } from '../lib/storage.js'
import { send, watchConfig, openAsWindow, surface } from '../ui/messaging.js'
import GenerateView from './views/GenerateView.jsx'
import NotionView from './views/NotionView.jsx'
import AiView from './views/AiView.jsx'
import SettingsView from './views/SettingsView.jsx'

/**
 * One page, four views, three surfaces: the Chrome side panel (click the
 * toolbar icon), a detached window (↗), and the options page. All state that
 * matters lives in chrome.storage, so every surface shows the same thing and
 * closing any of them loses nothing — including while a run is in progress.
 */

const VIEWS = [
  { id: 'generate', label: 'Generate' },
  { id: 'notion', label: 'Notion' },
  { id: 'ai', label: 'AI' },
  { id: 'settings', label: 'Settings' },
]

const viewFromHash = () => (location.hash.replace('#', '') || 'generate')

export default function App() {
  const [view, setView] = useState(viewFromHash)
  const [config, setConfig] = useState(null)
  const [ai, setAi] = useState(null)

  const refresh = useCallback(async () => {
    const [cfg, aiState] = await Promise.all([getConfig(), send('DESCRIBE_AI').catch(() => ({ ok: false }))])
    setConfig(cfg)
    setAi(aiState)
  }, [])

  useEffect(() => {
    refresh()
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    // Chrome tears the panel down when it is closed and rebuilds it on reopen,
    // so state is always re-read here rather than held in memory. Storage also
    // tells us when the worker changes something while a view is open.
    const stop = watchConfig(() => refresh())
    return () => { window.removeEventListener('hashchange', onHash); stop() }
  }, [refresh])

  const go = (id) => { location.hash = id; setView(id) }

  const update = async (patch) => {
    const { config: next } = await send('SAVE_CONFIG', { patch })
    setConfig(next)
    setAi(await send('DESCRIBE_AI').catch(() => ({ ok: false })))
    return next
  }

  const updateProvider = async (providerId, patch) => {
    const { config: next } = await send('SAVE_PROVIDER_CONFIG', { providerId, patch })
    setConfig(next)
    setAi(await send('DESCRIBE_AI').catch(() => ({ ok: false })))
    return next
  }

  /**
   * Three separate facts, not two. "Notion is connected" and "we know where to
   * put the notes" are different problems with different fixes, and collapsing
   * them told a connected user to connect again.
   */
  const status = {
    ai: Boolean(ai?.ok),
    notion: Boolean(resolveNotionToken(config)),
    destination: Boolean(config?.notionParentId),
  }
  const ready = status.ai && status.notion && status.destination

  if (!config) {
    return (
      <div className="shell">
        <div className="content" style={{ paddingTop: 24 }}>
          <div className="row muted small"><span className="spinner" /> Loading…</div>
        </div>
      </div>
    )
  }

  const props = { config, ai, status, update, updateProvider, go }

  return (
    <div className={`shell ${surface() === 'tab' ? 'window' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden>B</span>
          <h1>Brototype AI Notes</h1>
          {surface() === 'panel' && (
            <button className="icon quiet" title="Open in a separate window" onClick={openAsWindow}>↗</button>
          )}
        </div>
        <nav className="nav" aria-label="Sections">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => go(v.id)}
                    aria-current={view === v.id ? 'page' : undefined}>
              {v.label}
              {/* A quiet dot on the tab that still needs attention, so setup is
                  discoverable without a banner shouting on every screen. */}
              {!ready && ((v.id === 'notion' && (!status.notion || !status.destination)) || (v.id === 'ai' && !status.ai)) && (
                <span className="badge" aria-label="needs setup" />
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {view === 'generate' && <GenerateView {...props} />}
        {view === 'notion' && <NotionView {...props} />}
        {view === 'ai' && <AiView {...props} />}
        {view === 'settings' && <SettingsView {...props} />}
      </main>
    </div>
  )
}
