import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = `${ROOT}/dist`
const built = existsSync(`${DIST}/manifest.json`)

/**
 * These check the BUILT output, so they only run after `npm run build`.
 * They exist because the build can be correct in every source file and still
 * produce something Chrome complains about.
 */

test('the built pages emit no modulepreload hints', { skip: !built && 'run npm run build first' }, () => {
  // Vite's <link rel="modulepreload" crossorigin> never matches inside an
  // extension page, so Chrome logs two warnings per chunk on chrome://extensions
  // ("cross-world extension resource mismatch", then "preloaded but not used").
  for (const file of readdirSync(DIST).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(`${DIST}/${file}`, 'utf8')
    assert.ok(!html.includes('modulepreload'), `${file} still contains a modulepreload hint`)
  }
})

test('everything manifest.json references actually exists', { skip: !built && 'run npm run build first' }, () => {
  const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'))
  const required = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    ...Object.values(manifest.icons),
  ]
  // The UI is a side panel now: an action popup would close on every blur.
  assert.ok(!manifest.action.default_popup, 'default_popup must not be set')
  assert.ok(manifest.permissions.includes('sidePanel'))
  // Minimum permissions for the Web Store: no "tabs" (browsing history
  // warning) and no access to arbitrary sites. Brototype tab urls are visible
  // through the host permission alone.
  assert.ok(!manifest.permissions.includes('tabs'), '"tabs" is not needed and warns on the Web Store')
  assert.ok(!manifest.optional_host_permissions, 'no <all_urls>-style optional access')
  assert.ok(!manifest.host_permissions.some((h) => /<all_urls>|^https?:\/\/\*\/\*$/.test(h)), 'no all-hosts permission')
  assert.ok(manifest.host_permissions.some((h) => /brototype\.com/.test(h)), 'Brototype must need no permission prompt')
  assert.ok(manifest.content_security_policy?.extension_pages?.includes("script-src 'self'"), 'local code only')
  for (const file of required) {
    assert.ok(existsSync(`${DIST}/${file}`), `manifest references missing file: ${file}`)
  }
  // content.js is injected programmatically, so the manifest does not list it.
  assert.ok(existsSync(`${DIST}/content.js`), 'content.js is missing')
})

test('the code and the manifest agree on which sign-in server this build uses', { skip: !built && 'run npm run build first' }, () => {
  // Two halves have to match or Notion sign-in fails with a network error that
  // looks exactly like "the server is down": the URL Vite bakes into the code,
  // and the host permission Chrome checks before letting the request out.
  const source = JSON.parse(readFileSync(`${ROOT}/manifest.json`, 'utf8'))
  const build = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'))

  const added = build.host_permissions.filter((h) => !source.host_permissions.includes(h))
  assert.equal(added.length, 1, `build.js should add exactly one host permission, added: ${added.join(', ') || 'none'}`)

  const origin = added[0].replace(/\/\*$/, '')
  const bundled = readdirSync(`${DIST}/chunks`).filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(`${DIST}/chunks/${f}`, 'utf8')).join('')
  assert.ok(bundled.includes(origin), `the bundle does not contain ${origin}, so the code targets a different server than the manifest allows`)
})

test('the built extension never talks to Notion\'s confidential token endpoint', { skip: !built && 'run npm run build first' }, () => {
  // That endpoint authenticates with Basic client_id:client_secret. If the
  // extension called it, a client secret would have to be inside the bundle —
  // which is precisely what the backend exists to prevent.
  const files = readdirSync(DIST).filter((f) => f.endsWith('.js'))
    .concat(readdirSync(`${DIST}/chunks`).map((f) => `chunks/${f}`))
    .filter((f) => !f.endsWith('.map'))
  for (const file of files) {
    const source = readFileSync(`${DIST}/${file}`, 'utf8')
    assert.ok(!source.includes('oauth/token'), `${file} calls Notion's token endpoint directly`)
    assert.ok(!/Basic \$\{|btoa\(/.test(source), `${file} builds an HTTP Basic credential`)
  }
})

test('the built content script still cannot carry a secret', { skip: !built && 'run npm run build first' }, () => {
  const source = readFileSync(`${DIST}/content.js`, 'utf8')
  for (const secret of ['apiKey', 'notionToken', 'x-goog-api-key', 'x-api-key', 'Authorization', 'generativelanguage', 'api.notion.com']) {
    assert.ok(!source.includes(secret), `built content.js references ${secret}`)
  }
})

test('no real-looking API key was bundled', { skip: !built && 'run npm run build first' }, () => {
  const patterns = [/AIza[0-9A-Za-z_-]{20,}/, /sk-[a-zA-Z0-9]{20,}/, /sk-ant-[a-zA-Z0-9-]{20,}/, /xai-[a-zA-Z0-9]{20,}/, /\bntn_[a-zA-Z0-9]{20,}/]
  const files = readdirSync(DIST).filter((f) => f.endsWith('.js'))
    .concat(readdirSync(`${DIST}/chunks`).map((f) => `chunks/${f}`))
    .filter((f) => !f.endsWith('.map'))

  for (const file of files) {
    const source = readFileSync(`${DIST}/${file}`, 'utf8')
    for (const pattern of patterns) {
      assert.ok(!pattern.test(source), `${file} looks like it contains a real key (${pattern})`)
    }
  }
})
