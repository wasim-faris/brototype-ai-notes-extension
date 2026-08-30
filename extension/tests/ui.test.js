import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * Render smoke tests. There is no browser here, so each view is bundled with
 * esbuild and rendered to a string with React. That catches the class of bug
 * a rewrite most often introduces - an undefined prop, a bad import, a hook
 * outside a component - without needing Chrome.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Under node_modules so the externalised `react` resolves to the SAME copy
// the test renders with (two React instances would break hooks).
const out = join(ROOT, 'node_modules/.cache/ui-smoke')
mkdirSync(out, { recursive: true })

// The views touch `chrome.*` only inside effects and handlers, which a string
// render never runs. `location` is read at module load for the surface.
globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://x/${p}` }, storage: { onChanged: { addListener() {}, removeListener() {} } } }
globalThis.location = { search: '', pathname: '/app.html', hash: '' }
globalThis.window = { innerWidth: 400, addEventListener() {}, removeEventListener() {} }

async function load(entry) {
  const file = join(out, entry.replace(/[\\/]/g, '_') + '.mjs')
  await build({
    entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', outfile: file, platform: 'node',
    jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react-dom', 'react-dom/server'], logLevel: 'silent',
  })
  return import(pathToFileURL(file).href)
}

const { renderToString } = await import('react-dom/server')
const React = await import('react')

const config = {
  notionToken: 'ntn_abcdefghijklmnop', notionAuth: null, notionOAuthBackendUrl: '',
  notionParentId: 'p1', notionParentTitle: '📚 Brototype Notes',
  ai: { mode: 'direct', activeProvider: 'gemini', backendUrl: 'http://localhost:8787', providers: { gemini: { apiKey: 'AIzaXXXXXXXXXXXXXXXX', model: 'gemini-3.6-flash', baseUrl: '' } } },
  duplicateStrategy: 'ask', aiRequestsPerMinute: null, taskListSelector: '#root > div',
}
const ai = { ok: true, description: 'Google Gemini · gemini-3.6-flash' }
const status = { notion: true, ai: true }
const noop = async () => config

test('every view renders without throwing, with realistic props', async () => {
  const views = {
    'src/app/views/GenerateView.jsx': { config, ai, status, update: noop, updateProvider: noop, go() {} },
    'src/app/views/NotionView.jsx': { config, ai, status, update: noop, go() {} },
    'src/app/views/AiView.jsx': { config, ai, status, update: noop, updateProvider: noop, go() {} },
    'src/app/views/SettingsView.jsx': { config, update: noop },
    'src/app/views/ManualPaste.jsx': { onUse() {}, onCancel() {} },
  }
  for (const [entry, props] of Object.entries(views)) {
    const mod = await load(entry)
    const html = renderToString(React.createElement(mod.default, props))
    assert.ok(html.length > 200, `${entry} rendered almost nothing`)
    assert.ok(!/undefined|\[object Object\]/.test(html), `${entry} rendered a stray value`)
  }
})

test('a disconnected Notion view is one line and one button, with no technical noise', async () => {
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const fresh = { ...config, notionToken: '', notionAuth: null, notionParentId: '', notionParentTitle: '' }
  const html = renderToString(React.createElement(NotionView, { config: fresh, update: noop, go() {} }))

  assert.ok(html.includes('Not connected'))
  assert.ok(html.includes('Connect your Notion account to save your study notes.'))
  assert.ok(html.includes('Continue with Notion'), 'the OAuth button is the primary action')
  assert.ok(/class="primary big"/.test(html), 'and it is the big primary button, not a link')

  // The manual token path survives for development, but only under Advanced.
  const advancedAt = html.indexOf('<summary>Advanced</summary>')
  assert.ok(advancedAt > 0, 'the token box lives under Advanced')

  // Nothing a student cannot act on may appear before Advanced: no server
  // URLs, no developer instructions, no OAuth vocabulary.
  const primary = html.slice(0, advancedAt)
  assert.ok(!primary.includes('localhost'), 'no server URL in the primary UI')
  assert.ok(!/npm start|backend|\.env|CLIENT_SECRET|ntn_|redirect|OAuth/i.test(primary),
    'no developer vocabulary in the primary UI')
  assert.ok(html.indexOf('Continue with Notion') < advancedAt, 'OAuth must come first')
  assert.ok(html.indexOf('Use secret') > advancedAt, 'the integration-secret box is inside Advanced')
})

test('a Notion view connected by OAuth reads "Connected" and offers Find Pages', async () => {
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const oauth = {
    ...config,
    notionToken: '',
    notionAuth: { accessToken: 'ntn_oauth_secret_value', refreshToken: '', workspaceName: 'Wasim\u2019s Notion', workspaceIcon: '', workspaceId: 'w1', botId: 'b1', ownerName: '', connectedAt: 1 },
  }
  const html = renderToString(React.createElement(NotionView, { config: oauth, update: noop, go() {} }))

  assert.ok(html.includes('<strong>Connected</strong>'))
  assert.ok(html.includes('Notion account connected successfully'))
  assert.ok(html.includes('Wasim\u2019s Notion'), 'names the workspace it is connected to')
  assert.ok(html.includes('Disconnect'))
  assert.ok(!html.includes('Continue with Notion'), 'nothing to connect once connected')
  assert.ok(!html.includes('ntn_oauth_secret_value'), 'an OAuth access token is never rendered at all')
})

test('an existing pasted secret still connects, and is still masked', async () => {
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const html = renderToString(React.createElement(NotionView, { config, update: noop, go() {} }))
  assert.ok(html.includes('<strong>Connected</strong>'), 'a pre-OAuth setup must not read as broken')
  assert.ok(html.includes('Connected with an integration secret'))
  assert.ok(!html.includes('ntn_abcdefghijklmnop'), 'the full secret must never be rendered')
  assert.ok(html.includes('mnop'), 'but its last characters are shown so you can recognise it')
})

test('with no destination yet, the connected view offers to make one or pick one', async () => {
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const oauth = {
    ...config, notionToken: '', notionParentId: '', notionParentTitle: '',
    notionAuth: { accessToken: 'ntn_x', workspaceName: 'Study' },
  }
  const html = renderToString(React.createElement(NotionView, { config: oauth, update: noop, go() {} }))

  assert.ok(html.includes('Create new page'), 'creating the page is offered first')
  assert.ok(html.includes('Choose existing page'))
  assert.ok(html.indexOf('Create new page') < html.indexOf('Choose existing page'), 'create comes first')

  // The whole point: none of the manual Notion housekeeping is asked for.
  assert.ok(!/Connections|my-integrations|share/i.test(html.slice(html.indexOf('Where should study pages'))),
    'no manual Notion steps in the destination flow')
})

test('an integration secret is not offered a button Notion would refuse', async () => {
  // Notion only allows a top-level page for an OAuth connection, so offering
  // "Create New Page" to a token connection would be a dead button.
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const token = { ...config, notionAuth: null, notionParentId: '', notionParentTitle: '' }
  const html = renderToString(React.createElement(NotionView, { config: token, update: noop, go() {} }))

  assert.ok(!html.includes('Create new page'), 'no create button for a connection that cannot create')
  assert.ok(html.includes('Choose existing page'))
})

test('once a destination exists it is named, and changeable', async () => {
  const { default: NotionView } = await load('src/app/views/NotionView.jsx')
  const oauth = { ...config, notionToken: '', notionAuth: { accessToken: 'ntn_x', workspaceName: 'Study' } }
  const html = renderToString(React.createElement(NotionView, { config: oauth, update: noop, go() {} }))

  assert.ok(html.includes('Saving into'))
  assert.ok(html.includes('📚 Brototype Notes'), 'the chosen page is named')
  assert.ok(html.includes('Change'))
  assert.ok(html.includes('Go to Generate'), 'and the next step is generating')
})

test('every button in the Notion tab is wired to something', async () => {
  // A button with no onClick is a dead button; the source is checked because a
  // string render cannot tell a wired handler from a missing one.
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src/app/views/NotionView.jsx'), 'utf8')
  const buttons = src.match(/<button[^>]*>/g) || []
  assert.ok(buttons.length >= 6, `expected the Notion tab to have buttons, found ${buttons.length}`)
  for (const button of buttons) {
    assert.ok(/onClick=/.test(button), `dead button: ${button}`)
  }
})

test('the AI view states its connection first, then the few fields, never the key', async () => {
  const { default: AiView } = await load('src/app/views/AiView.jsx')
  const html = renderToString(React.createElement(AiView, { config, ai, update: noop, updateProvider: noop, go() {} }))

  // Connection state before configuration: the question is "is this working?",
  // not "what are my settings?".
  assert.ok(html.includes('<strong class="grow">Connected</strong>'))
  assert.ok(html.indexOf('Connected') < html.indexOf('Provider'), 'state comes before settings')

  const order = ['Provider', 'API key', 'Model'].map((t) => html.indexOf(`<span class="label">${t}</span>`))
  assert.ok(order.every((i) => i >= 0), `missing a field: ${order}`)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'fields out of order')

  assert.ok(!html.includes('AIzaXXXXXXXXXXXXXXXX'), 'the key is never rendered')
  assert.ok(html.includes('Google Gemini'), 'the active provider is named')

  // Developer configuration must not sit in the normal flow.
  const advancedAt = html.indexOf('<summary>Advanced</summary>')
  assert.ok(advancedAt > 0)
  assert.ok(html.indexOf('base URL') > advancedAt, 'the base URL belongs under Advanced')
  assert.ok(html.indexOf('How the provider is reached') > advancedAt, 'transport choice belongs under Advanced')
})

test('the progress view shows a bar, the live line, and hides the log behind Details', async () => {
  const { default: ProgressView } = await load('src/app/views/ProgressView.jsx')
  const job = {
    status: 'running', pageTitle: 'Mod 6 — React', currentMessage: '  ↳ b. Shared state', notionPageUrl: null, error: null, warnings: [],
    tasks: [{ number: 1, title: 'Hooks', status: 'done', message: '' }, { number: 2, title: 'State', status: 'active', message: '' }, { number: 3, title: 'Context', status: 'pending', message: '' }],
    log: [{ level: 'info', message: 'Using OpenRouter' }],
  }
  const html = renderToString(React.createElement(ProgressView, { job, onCancel() {}, onResume() {}, onReset() {} }))
  // The live line is what proves the extension has not frozen.
  assert.ok(html.includes('b. Shared state'))
  assert.ok(html.includes('width:33%'))
  assert.ok(html.includes('<summary>Details</summary>'))
  assert.ok(html.includes('Cancel'))

  const finished = { ...job, status: 'done', currentMessage: 'Done.', notionPageUrl: 'https://notion.so/x', tasks: job.tasks.map((t) => ({ ...t, status: 'done' })) }
  const doneHtml = renderToString(React.createElement(ProgressView, { job: finished, onCancel() {}, onResume() {}, onReset() {} }))
  assert.ok(doneHtml.includes('Study notes generated'))
  assert.ok(doneHtml.includes('Open in Notion'))
  assert.ok(doneHtml.includes('Done'), 'a finished run offers a way out')
  assert.ok(doneHtml.includes('width:100%'))
  assert.ok(!doneHtml.includes('Cancel'), 'nothing left to cancel once it is done')

  const failed = { ...finished, notionPageUrl: null, tasks: [...job.tasks.slice(0, 2), { number: 3, title: 'Context', status: 'failed', message: 'rate limit' }] }
  const failedHtml = renderToString(React.createElement(ProgressView, { job: failed, onCancel() {}, onResume() {}, onReset() {} }))
  assert.ok(failedHtml.includes('Retry failed'))
  // renderToString escapes apostrophes, so match a fragment without one.
  assert.ok(failedHtml.includes('Some tasks'), 'partial failure names itself')
  assert.ok(/class="callout warn"/.test(failedHtml), 'and reads as a warning, not a crash')
})

test('the generate view shows what is missing before anything is attempted', async () => {
  const { default: GenerateView } = await load('src/app/views/GenerateView.jsx')
  const html = renderToString(React.createElement(GenerateView,
    { config, ai: { ok: false }, status: { ai: false, notion: false, destination: false }, update: noop, go() {} }))

  // Both services are named with their own state and their own button, rather
  // than one banner pointing at whichever happens to be first.
  assert.ok(html.includes('Before you start'))
  assert.ok(html.includes('Connect an AI provider to write your notes.'))
  assert.ok(html.includes('Connect AI'))
  assert.ok(html.includes('Connect Notion to save your study notes.'))
  assert.ok(html.includes('Connect Notion'))
  assert.ok(!html.includes('Generate study notes'), 'no generate button before the page has been read')
})

test('Notion connected without a destination reads as a warning, not as disconnected', async () => {
  // The old status collapsed these two into "Notion needs setup", which told a
  // connected user to connect again.
  const { default: GenerateView } = await load('src/app/views/GenerateView.jsx')
  const html = renderToString(React.createElement(GenerateView,
    { config, ai, status: { ai: true, notion: true, destination: false }, update: noop, go() {} }))

  assert.ok(html.includes('Connected — choose where your notes should be saved.'))
  assert.ok(html.includes('Choose page'))
  assert.ok(!html.includes('Connect Notion to save your study notes.'), 'must not claim Notion is disconnected')
  assert.ok(html.includes('dot warn'), 'a missing destination is a warning, not an error')
})

test('when everything is ready the setup block gets out of the way', async () => {
  const { default: GenerateView } = await load('src/app/views/GenerateView.jsx')
  const html = renderToString(React.createElement(GenerateView,
    { config, ai, status: { ai: true, notion: true, destination: true }, update: noop, go() {} }))
  assert.ok(!html.includes('Before you start'), 'no setup card once there is nothing to set up')
})

test('the study style UI is gone from every view', async () => {
  for (const entry of ['src/app/views/SettingsView.jsx', 'src/app/views/AiView.jsx', 'src/app/views/GenerateView.jsx']) {
    const mod = await load(entry)
    const html = renderToString(React.createElement(mod.default, { config, ai, status, update: noop, updateProvider: noop, go() {} }))
    assert.ok(!/study style|customPrompt|Custom instructions/i.test(html), `${entry} still exposes study style`)
  }
})


test('the shell tracks connection and destination as separate facts', async () => {
  const { default: App } = await load('src/app/App.jsx')
  // App loads config in an effect, so a string render shows the loading shell
  // only; the status model itself is pinned here so it cannot silently collapse
  // back into one boolean.
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'src/app/App.jsx'), 'utf8')
  assert.ok(/notion: Boolean\(resolveNotionToken\(config\)\)/.test(src), 'connection is its own fact')
  assert.ok(/destination: Boolean\(config\?\.notionParentId\)/.test(src), 'destination is its own fact')
  assert.ok(!/notion: Boolean\(resolveNotionToken\(config\) && config\?\.notionParentId\)/.test(src),
    'the two must not be collapsed into one status again')
  assert.ok(App)
})

test('a fresh install\'s AI screen asks for the user\'s own key: provider dropdown, key box, test - not under Advanced', async () => {
  const { default: AiView } = await load('src/app/views/AiView.jsx')
  const { DEFAULT_CONFIG } = await import('../src/lib/storage.js')
  const html = renderToString(React.createElement(AiView, { config: DEFAULT_CONFIG, ai: { ok: false, message: 'No API key is saved for OpenRouter.' }, update: noop, updateProvider: noop, go() {} }))

  assert.ok(html.includes('<strong class="grow">Not connected</strong>'))
  assert.ok(/your own API key/i.test(html), 'says the key is the user\'s own')

  const advancedAt = html.indexOf('<summary>Advanced</summary>')
  const primary = html.slice(0, advancedAt)
  const order = ['Provider', 'API key', 'Model'].map((t) => primary.indexOf(`<span class="label">${t}</span>`))
  assert.ok(order.every((i) => i >= 0), `provider, key and model must be in the primary flow, got ${order}`)
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.ok(primary.includes('<option value="openrouter" selected="">OpenRouter</option>'), 'OpenRouter is the default selection')
  for (const label of ['Google Gemini', 'OpenAI', 'Anthropic Claude', 'xAI Grok', 'Custom / OpenAI-compatible']) {
    assert.ok(primary.includes(`>${label}</option>`), `${label} is no longer offered`)
  }
  assert.ok(primary.includes('Test connection'))
  assert.ok(primary.includes('openrouter.ai'), 'links to where a key comes from')
  assert.ok(!/shared AI service|Render|localhost/i.test(primary), 'no server talk in the primary flow')
  // The dev-only proxy toggle stays under Advanced (this is an unbuilt module, i.e. a dev build).
  assert.ok(html.indexOf('Shared AI service') > advancedAt)
})
