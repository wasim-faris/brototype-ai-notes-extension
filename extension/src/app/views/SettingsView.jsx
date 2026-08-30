import { DEFAULT_CONFIG } from '../../lib/storage.js'
import { openAsWindow, surface } from '../../ui/messaging.js'
import { Panel, Field } from '../../ui/components.jsx'

/**
 * Settings a student might actually change, then — folded away — the ones only
 * somebody debugging the extension would.
 */
export default function SettingsView({ config, update }) {
  return (
    <>
      <Panel title="Generating notes">
        <Field label="If a page with the same name already exists">
          <select value={config.duplicateStrategy} onChange={(e) => update({ duplicateStrategy: e.target.value })}>
            <option value="ask">Ask me each time</option>
            <option value="new">Create a second version</option>
            <option value="update">Replace what is there</option>
            <option value="skip">Add to the existing page</option>
          </select>
        </Field>
      </Panel>

      <Panel title="Where this opens">
        <p className="small muted">
          The extension lives in Chrome's side panel — click the toolbar icon to open or close it. It stays
          open while you switch tabs. To keep it visible beside another app, open it in its own window.
        </p>
        {surface() === 'panel' && <button onClick={openAsWindow}>Open in a separate window</button>}
        <p className="tiny muted">Generating runs in the background either way — closing this never loses a run.</p>
      </Panel>

      <Panel title="Your data">
        <p className="small muted">
          Your Notion connection and AI key are stored only in this Chrome profile. They are never sent
          anywhere except to Notion and the AI provider you chose, and websites cannot read them.
        </p>
        <p className="small muted">
          Page content is read only after you allow it, and only from the tab you are looking at.
        </p>
      </Panel>

      <Panel>
        <details>
          <summary>Advanced</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            <Field label="AI requests per minute" hint="Leave empty to use the provider's own rate. Lower it if you keep hitting rate limits.">
              <input type="text" inputMode="numeric" placeholder="Provider default" value={config.aiRequestsPerMinute ?? ''}
                     onChange={(e) => update({ aiRequestsPerMinute: e.target.value.trim() === '' ? null : Number(e.target.value) || 0 })} />
            </Field>

            {config.taskListSelector && (
              <Field label="Remembered task-list location" hint="Set when you pointed at the list on the page. Forget it if the site changed.">
                <div className="row">
                  <code className="grow truncate tiny">{config.taskListSelector}</code>
                  <button onClick={() => update({ taskListSelector: '' })}>Forget</button>
                </div>
              </Field>
            )}

            <button className="danger" onClick={() => confirm('Reset every setting, including your saved keys and Notion connection?') && update(DEFAULT_CONFIG)}>
              Reset all settings
            </button>
          </div>
        </details>
      </Panel>
    </>
  )
}
