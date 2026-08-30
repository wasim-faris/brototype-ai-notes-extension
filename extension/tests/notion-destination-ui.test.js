import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

/**
 * The destination flow, clicked rather than read.
 *
 * The other view tests render to a string, which cannot press a button — so
 * they can only see the first screen. Cancelling, the loading state and the
 * error branch only exist after a click, and those are exactly the states a
 * user hits when something goes wrong. This drives the real component in jsdom.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(ROOT, 'node_modules/.cache/ui-interactive')
mkdirSync(out, { recursive: true })

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://x/app.html' })
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 22 defines navigator as a getter-only global; React only needs it present.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.location = dom.window.location
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// What the view asks the service worker for, and what it gets back.
let sent = []
let reply = async () => ({})
globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://x/${p}`,
    sendMessage: async (message) => {
      sent.push(message)
      try { return { ok: true, data: await reply(message) } }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } } }
    },
  },
  storage: { onChanged: { addListener() {}, removeListener() {} } },
}
dom.window.confirm = () => true

const file = join(out, 'NotionView.mjs')
await build({
  entryPoints: [join(ROOT, 'src/app/views/NotionView.jsx')], bundle: true, format: 'esm', outfile: file,
  platform: 'node', jsx: 'automatic', loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client'], logLevel: 'silent',
})
const { default: NotionView } = await import(pathToFileURL(file).href)
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')

const connected = {
  notionToken: '', notionOAuthBackendUrl: '', notionParentId: '', notionParentTitle: '',
  notionAuth: { accessToken: 'ntn_x', workspaceName: 'Study Space' },
  ai: { mode: 'direct', activeProvider: 'gemini', backendUrl: '', providers: {} },
  duplicateStrategy: 'ask', aiRequestsPerMinute: null, taskListSelector: '',
}

/** Mount the view and hand back helpers for driving it. */
async function mount(config = connected) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(NotionView, { config, update: async () => config, go() {} })) })

  const buttons = () => [...host.querySelectorAll('button')]
  return {
    host,
    text: () => host.textContent,
    button: (label) => buttons().find((b) => b.textContent.trim() === label),
    click: async (label) => {
      const target = buttons().find((b) => b.textContent.trim() === label)
      assert.ok(target, `no button labelled "${label}" — have: ${buttons().map((b) => b.textContent.trim()).join(' | ')}`)
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    },
    type: async (value) => {
      const input = host.querySelector('input[type="text"]')
      assert.ok(input, 'no text input on screen')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    input: () => host.querySelector('input[type="text"]'),
  }
}

test.beforeEach(() => {
  sent = []
  reply = async () => ({})
})

test('Create New Page asks for a name, then creates and selects it', async () => {
  reply = async (m) => {
    if (m.type === 'CREATE_NOTION_PAGE') return { id: 'p-new', title: m.payload.title, url: 'https://notion.so/p-new' }
    return {}
  }
  const ui = await mount()

  await ui.click('Create new page')
  assert.ok(ui.input(), 'a name box appears')
  assert.equal(ui.input().value, 'Brototype Notes', 'prefilled with a sensible name')

  await ui.type('Semester 1 Notes')
  await ui.click('Create page')

  const call = sent.find((m) => m.type === 'CREATE_NOTION_PAGE')
  assert.ok(call, 'the page is actually created through the worker')
  assert.equal(call.payload.title, 'Semester 1 Notes')
  assert.ok(ui.text().includes('Page created'), 'success is stated')
  assert.ok(ui.text().includes('Open in Notion'), 'and linked')
})

test('an empty name cannot be submitted', async () => {
  const ui = await mount()
  await ui.click('Create new page')
  await ui.type('   ')
  assert.ok(ui.button('Create page').disabled, 'Create Page is disabled for a blank name')
  await ui.type('Notes')
  assert.ok(!ui.button('Create page').disabled)
})

test('Cancel returns to the choice without creating anything', async () => {
  const ui = await mount()
  await ui.click('Create new page')
  await ui.click('Cancel')

  assert.ok(ui.button('Create new page'), 'back at the choice')
  assert.ok(!ui.input(), 'the name box is gone')
  assert.equal(sent.filter((m) => m.type === 'CREATE_NOTION_PAGE').length, 0, 'nothing was created')
})

test('a failed creation explains itself and offers both ways forward', async () => {
  reply = async (m) => {
    if (m.type === 'CREATE_NOTION_PAGE') {
      throw Object.assign(new Error('Notion did not allow this. The connection needs both read and insert content capabilities.'), { code: 'NOTION_FORBIDDEN' })
    }
    return { pages: [] }
  }
  const ui = await mount()
  await ui.click('Create new page')
  await ui.click('Create page')

  assert.ok(ui.text().includes("Couldn't create the page"))
  assert.ok(ui.text().includes('insert content'), 'Notion\'s reason is shown')
  assert.ok(ui.button('Try again'), 'retry is offered')
  assert.ok(ui.button('Choose existing page'), 'and so is the other route')
})

test('Try again after a failure really retries', async () => {
  let attempts = 0
  reply = async (m) => {
    if (m.type !== 'CREATE_NOTION_PAGE') return {}
    attempts++
    if (attempts === 1) throw Object.assign(new Error('Notion had a temporary server error.'), { code: 'NOTION_SERVER' })
    return { id: 'p-new', title: m.payload.title, url: null }
  }
  const ui = await mount()
  await ui.click('Create new page')
  await ui.click('Create page')
  assert.ok(ui.text().includes("Couldn't create the page"))

  await ui.click('Try again')
  assert.equal(attempts, 2)
  assert.ok(ui.text().includes('Page created'))
})

test('Select Existing Page loads pages, and Back returns to the choice', async () => {
  reply = async (m) => (m.type === 'LIST_NOTION_PAGES'
    ? { pages: [{ id: 'p1', title: 'Study Hub', icon: '📘' }] }
    : {})
  const ui = await mount()

  await ui.click('Choose existing page')
  assert.ok(sent.some((m) => m.type === 'LIST_NOTION_PAGES'), 'pages load without a second click')
  assert.ok(ui.text().includes('Study Hub'))
  assert.ok(ui.button('Use this'))

  await ui.click('Back')
  assert.ok(ui.button('Create new page'), 'back at the choice')
})

test('when the connection has no pages, creating one is offered as the way out', async () => {
  reply = async (m) => (m.type === 'LIST_NOTION_PAGES' ? { pages: [] } : {})
  const ui = await mount()

  await ui.click('Choose existing page')
  assert.ok(ui.text().includes('No pages found'))
  assert.ok(ui.button('Create one instead'), 'the dead end has an exit')

  await ui.click('Create one instead')
  assert.ok(ui.input(), 'which leads straight to the name box')
})

test('a page-loading failure is reported with a retry, not left blank', async () => {
  reply = async (m) => {
    if (m.type === 'LIST_NOTION_PAGES') throw Object.assign(new Error('Notion rejected these credentials.'), { code: 'NOTION_UNAUTHORIZED' })
    return {}
  }
  const ui = await mount()
  await ui.click('Choose existing page')

  assert.ok(ui.text().includes("Couldn't load your pages"))
  assert.ok(ui.text().includes('Notion rejected these credentials'))
  assert.ok(ui.button('Try again'))
})

const withDestination = { ...connected, notionParentId: 'p-old', notionParentTitle: 'Old Notes' }

test('Change actually opens the chooser over an existing destination', async () => {
  // This was a dead button: the "Saving into …" branch won the render, so
  // pressing Change left the screen exactly as it was.
  const ui = await mount(withDestination)
  assert.ok(ui.text().includes('Saving into'))

  await ui.click('Change')
  assert.ok(ui.button('Create new page'), 'the chooser is now on screen')
  assert.ok(ui.button('Choose existing page'))
})

test('backing out of a change keeps the destination you already had', async () => {
  const ui = await mount(withDestination)
  await ui.click('Change')
  await ui.click('Keep Old Notes')

  assert.ok(ui.text().includes('Saving into'), 'still selected')
  assert.ok(ui.text().includes('Old Notes'))
  assert.ok(!ui.button('Create new page'), 'chooser is gone')
})

test('changing to a newly created page replaces the old destination', async () => {
  reply = async (m) => (m.type === 'CREATE_NOTION_PAGE'
    ? { id: 'p-new', title: m.payload.title, url: null }
    : {})
  const ui = await mount(withDestination)

  await ui.click('Change')
  await ui.click('Create new page')
  await ui.type('Semester 2')
  await ui.click('Create page')

  assert.ok(ui.text().includes('Page created'))
  const call = sent.find((m) => m.type === 'CREATE_NOTION_PAGE')
  assert.equal(call.payload.title, 'Semester 2')
})
