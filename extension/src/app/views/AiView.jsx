import { useEffect, useState } from 'react'
import { PROVIDERS, providerOptions } from '../../ai/registry.js'
import { maskSecret } from '../../lib/storage.js'
import { cleanValue, describeHidden, hasHiddenCharacters } from '../../ai/clean.js'
import { send } from '../../ui/messaging.js'
import { IS_DEV_BUILD } from '../../lib/env.js'
import { Panel, Callout, Field, Secret, Spinner } from '../../ui/components.jsx'

/**
 * The AI, as a student sees it.
 *
 * Normally there is nothing to decide: notes are written by the shared
 * service, which holds the only key. The screen says so and offers a test.
 *
 * Under Advanced a student (or a developer) can use their own API key
 * instead: then the three real decisions appear — which service, its key,
 * and (rarely) which model. Every provider keeps its own saved settings, so
 * switching never loses a key.
 */
export default function AiView({ config, ai, update, updateProvider, go }) {
  const { mode, activeProvider, backendUrl, providers } = config.ai
  const meta = PROVIDERS[activeProvider]
  const saved = providers[activeProvider] || {}

  const [draft, setDraft] = useState({ baseUrl: saved.baseUrl || '', model: saved.model || '' })
  const [newKey, setNewKey] = useState(null)
  const [test, setTest] = useState({ state: 'idle' })
  const [advanced, setAdvanced] = useState(Boolean(saved.baseUrl) || mode === 'backend')
  const [flash, setFlash] = useState('')

  useEffect(() => {
    setDraft({ baseUrl: saved.baseUrl || '', model: saved.model || '' })
    setNewKey(null)
    setTest({ state: 'idle' })
  }, [activeProvider, saved.baseUrl, saved.model])

  const effectiveModel = (draft.model || meta.defaultModel || '').trim()
  const hasKey = Boolean(saved.apiKey)
  const keyReady = hasKey || Boolean((newKey || '').trim()) || meta.keyOptional
  const dirty = (draft.baseUrl || '') !== (saved.baseUrl || '') || (draft.model || '') !== (saved.model || '') || Boolean(newKey && newKey.trim())

  const say = (t) => { setFlash(t); setTimeout(() => setFlash(''), 1800) }

  const save = async () => {
    const patch = { baseUrl: draft.baseUrl.trim(), model: draft.model.trim() }
    if (newKey && newKey.trim()) patch.apiKey = newKey.trim()
    await updateProvider(activeProvider, patch)
    setNewKey(null)
    say('Saved')
  }

  const testConnection = async () => {
    setTest({ state: 'testing' })
    try {
      const result = await send('TEST_AI', {
        overrides: {
          mode, activeProvider, backendUrl,
          providers: { [activeProvider]: { baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: newKey && newKey.trim() ? newKey.trim() : saved.apiKey } },
        },
      })
      setTest({ state: 'ok', ...result })
    } catch (e) {
      setTest({ state: 'err', message: e.message, detail: e.detail })
    }
  }

  const canTest = Boolean(effectiveModel && keyReady && (draft.baseUrl || meta.defaultBaseUrl))
  const connected = Boolean(ai?.ok)

  const shared = mode === 'backend'

  const testResult = (
    <>
      {test.state === 'ok' && (
        <Callout kind="ok" title="Connection works">
          {shared ? 'The AI service answered.' : `${test.provider} · ${test.model}.`} This ran a real request, the same way generating notes does.
        </Callout>
      )}
      {test.state === 'err' && (
        <Callout kind="err" title={shared ? "AI service isn't reachable right now" : "Couldn't reach the AI provider"} actions={<button onClick={testConnection}>Try again</button>}>
          {test.message}
        </Callout>
      )}
    </>
  )

  return (
    <>
      {shared ? (
        <Panel title="AI">
          <div className="row">
            <span className={`dot ${test.state === 'testing' ? 'active' : test.state === 'err' ? 'bad' : 'ok'}`} />
            <strong className="grow">{test.state === 'testing' ? 'Checking…' : test.state === 'err' ? 'Not reachable' : 'Connected'}</strong>
          </div>
          <p className="small muted">
            Your study notes are written by the shared AI service. There is nothing to set up and no key to paste.
          </p>
          <div className="row wrap">
            <button onClick={testConnection} disabled={test.state === 'testing'}>
              {test.state === 'testing' ? <><Spinner /> Checking…</> : 'Test connection'}
            </button>
          </div>
          {testResult}
        </Panel>
      ) : (
      <Panel title="AI provider">
        <div className="row">
          <span className={`dot ${test.state === 'testing' ? 'active' : connected ? 'ok' : 'bad'}`} />
          <strong className="grow">{test.state === 'testing' ? 'Checking…' : connected ? 'Connected' : 'Not connected'}</strong>
        </div>
        <p className="small muted">
          {connected ? ai.description : 'Connect an AI provider to generate study notes.'}
        </p>

        <hr className="divider" />

        <Field label="Provider">
          <select value={activeProvider} onChange={(e) => update({ ai: { activeProvider: e.target.value } })}>
            {providerOptions().map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {meta.note && <span className="hint">{meta.note}</span>}
        </Field>

        {mode === 'direct' && (
          <Field
            label="API key"
            hint={<>{meta.keyUrl && <>Get one at <a href={meta.keyUrl} target="_blank" rel="noreferrer">{new URL(meta.keyUrl).host}</a>. </>}Stored only in this Chrome profile.</>}
          >
            {hasKey && newKey === null ? (
              <Secret masked={maskSecret(saved.apiKey)} onReplace={() => setNewKey('')} onDelete={() => updateProvider(activeProvider, { apiKey: '' })} />
            ) : (
              <>
                <input type="password" autoComplete="off" placeholder={meta.keyHint} value={newKey ?? ''} onChange={(e) => setNewKey(e.target.value)} />
                {hasKey && <button className="quiet" onClick={() => setNewKey(null)}>Keep the existing key</button>}
              </>
            )}
          </Field>
        )}

        <Field label="Model" hint="Leave as-is unless you know you want a different one.">
          <input type="text" list={`models-${activeProvider}`} placeholder={meta.defaultModel || 'model name'}
                 value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <datalist id={`models-${activeProvider}`}>{meta.modelSuggestions.map((m) => <option key={m} value={m} />)}</datalist>
        </Field>

        {hasHiddenCharacters(draft.model) && (
          <Callout kind="warn" title="That model name contains invisible characters"
                   actions={<button onClick={() => setDraft({ ...draft, model: cleanValue(draft.model) })}>Clean it up</button>}>
            Pasting from a web page sometimes brings them along, and the provider will reject the name.
          </Callout>
        )}

        <div className="row wrap">
          <button className="primary" onClick={save} disabled={!dirty}>{flash || 'Save'}</button>
          <button onClick={testConnection} disabled={!canTest || test.state === 'testing'}>
            {test.state === 'testing' ? <><Spinner /> Checking…</> : 'Test connection'}
          </button>
          {dirty && !flash && <span className="tiny muted">Unsaved changes</span>}
        </div>

        {testResult}
      </Panel>
      )}


      <Panel>
        <details open={advanced} onToggle={(e) => setAdvanced(e.target.open)}>
          <summary>Advanced</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {!shared && (
              <Field label="API base URL" hint={draft.baseUrl ? 'Custom — clear it to use the default.' : meta.defaultBaseUrl ? `Default: ${meta.defaultBaseUrl}` : 'Required for this provider.'}>
                <input type="url" placeholder={meta.defaultBaseUrl || 'https://your-server.example/v1'} value={draft.baseUrl}
                       onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
              </Field>
            )}

            <Field label="How the provider is reached">
              <label className={`choice ${shared ? 'selected' : ''}`}>
                <input type="radio" name="aimode" checked={shared} onChange={() => update({ ai: { mode: 'backend' } })} />
                <span className="small"><strong>Shared AI service</strong> — recommended. No key needed.</span>
              </label>
              <label className={`choice ${!shared ? 'selected' : ''}`}>
                <input type="radio" name="aimode" checked={!shared} onChange={() => update({ ai: { mode: 'direct' } })} />
                <span className="small"><strong>My own API key</strong> — this extension calls the provider you choose, with a key stored only in this Chrome profile.</span>
              </label>
            </Field>

            {shared && IS_DEV_BUILD && (
              <Field label="Server address" hint="Development builds only. Leave empty for the server this build was made for.">
                <input type="url" value={backendUrl} placeholder="http://localhost:8787" onChange={(e) => update({ ai: { backendUrl: e.target.value.trim() } })} />
              </Field>
            )}

            {test.state === 'err' && test.detail && (
              <Field label="Last error detail">
                <code className="tiny" style={{ wordBreak: 'break-all' }}>{test.detail}</code>
              </Field>
            )}
          </div>
        </details>
      </Panel>

      {(shared || connected) && <button className="primary" onClick={() => go('generate')}>Go to Generate</button>}
    </>
  )
}
