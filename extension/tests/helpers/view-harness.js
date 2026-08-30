import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'

/**
 * Mount a real view in jsdom and press its buttons.
 *
 * String rendering can only ever see a view's first screen, so it cannot tell
 * a working button from a decorative one. Everything a user actually does —
 * cancelling, retrying, going back — only exists after a click, which is what
 * this harness makes testable.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'node_modules/.cache/view-harness')
mkdirSync(OUT, { recursive: true })

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://x/app.html' })

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// Node 22 exposes navigator as a getter-only global; React only needs it present.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
dom.window.confirm = () => true

/** Messages the view sent to the service worker, newest last. */
export const sent = []
let reply = async () => ({})

/** Decide what the fake service worker answers. Reset between tests. */
export function onMessage(handler) {
  reply = handler
  sent.length = 0
}

export const tabsOpened = []

globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://x/${p}`,
    sendMessage: async (message) => {
      sent.push(message)
      try { return { ok: true, data: await reply(message) } }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message, detail: error.detail } } }
    },
  },
  storage: {
    local: { remove: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://campus.brototype.com/tasks/1', title: 'Task', windowId: 1 }],
    onActivated: { addListener() {}, removeListener() {} },
    onUpdated: { addListener() {}, removeListener() {} },
    create: async (opts) => { tabsOpened.push(opts.url) },
    sendMessage: async () => ({ ok: false, tasks: [] }),
  },
  windows: { onFocusChanged: { addListener() {}, removeListener() {} } },
  scripting: { executeScript: async () => {} },
  permissions: { contains: async () => true, request: async () => true },
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = React

/** Bundle a view once, with react left external so hooks share one copy. */
export async function loadView(entry) {
  const file = join(OUT, entry.replace(/[\\/]/g, '_') + '.mjs')
  await build({
    entryPoints: [join(ROOT, entry)], bundle: true, format: 'esm', outfile: file, platform: 'node',
    jsx: 'automatic', loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react-dom/client'], logLevel: 'silent',
  })
  return (await import(pathToFileURL(file).href)).default
}

/** Render a view and return helpers for driving it. */
export async function mount(View, props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(View, props)) })

  const buttons = () => [...host.querySelectorAll('button')]
  const label = (b) => b.textContent.trim()

  const ui = {
    host,
    text: () => host.textContent,
    html: () => host.innerHTML,
    buttons: () => buttons().map(label),
    button: (name) => buttons().find((b) => label(b) === name),
    async click(name) {
      const target = buttons().find((b) => label(b) === name)
      assert.ok(target, `no button labelled "${name}" — on screen: ${buttons().map(label).join(' | ')}`)
      assert.ok(!target.disabled, `button "${name}" is disabled`)
      await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    },
    input: (selector = 'input[type="text"]') => host.querySelector(selector),
    async type(value, selector) {
      const el = ui.input(selector)
      assert.ok(el, 'no input on screen')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(el, value)
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    async toggle(index) {
      const boxes = [...host.querySelectorAll('input[type="checkbox"]')]
      assert.ok(boxes[index], `no checkbox at ${index}`)
      await act(async () => { boxes[index].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    },
    checkboxes: () => [...host.querySelectorAll('input[type="checkbox"]')],
    async rerender(nextProps) {
      await act(async () => { root.render(React.createElement(View, nextProps)) })
    },
  }
  return ui
}
