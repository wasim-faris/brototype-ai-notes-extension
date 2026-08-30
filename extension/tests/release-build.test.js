import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * A RELEASE build, as it would be uploaded to the Chrome Web Store, built
 * here into a scratch folder and inspected.
 *
 * A dev build is allowed to know about localhost. The published extension is
 * not: every student's copy must talk to the deployed backend and nothing
 * else, and must contain no secret, no source map, and no dev-only literal.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROD = 'https://notes-backend.example-render.com'
const hasVite = existsSync(resolve(ROOT, 'node_modules/vite'))
const skip = !hasVite && 'npm install first'

let out = ''
function buildRelease(env) {
  out = mkdtempSync(join(tmpdir(), 'bro-release-'))
  execFileSync(process.execPath, ['build.js', '--release'], {
    cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, BACKEND_URL: env.BACKEND_URL ?? PROD, NOTION_BACKEND_URL: '', OUT_DIR: out },
  })
  return out
}

const allJs = (dir) => [
  ...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)),
  ...(existsSync(join(dir, 'chunks')) ? readdirSync(join(dir, 'chunks')).map((f) => join(dir, 'chunks', f)) : []),
].filter((f) => f.endsWith('.js'))

test.after(() => { if (out && existsSync(out)) rmSync(out, { recursive: true, force: true }) })

test('a release build refuses to be made without an https backend URL', { skip }, () => {
  for (const bad of ['', 'http://localhost:8787', 'http://my-server.example']) {
    assert.throws(
      () => execFileSync(process.execPath, ['build.js', '--release'], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, BACKEND_URL: bad, NOTION_BACKEND_URL: '', OUT_DIR: join(tmpdir(), 'bro-release-never') } }),
      `built a release against "${bad}"`,
    )
  }
})

test('the release bundle knows only the deployed backend: no localhost, no dev flag, no source maps, no secrets', { skip }, () => {
  const dir = buildRelease({})
  const files = allJs(dir)
  assert.ok(files.length >= 3, 'app, worker and content script were built')
  const bundle = files.map((f) => readFileSync(f, 'utf8')).join('\n')

  assert.ok(bundle.includes(PROD), 'the deployed URL is baked in')
  assert.ok(!/localhost|127\.0\.0\.1|:8787/.test(bundle), 'no development server literal survives a release build')
  assert.ok(!/npm start|backend\/\.env|\.env\b/.test(bundle), 'no developer instructions in the shipped code')

  for (const pattern of [/AIza[0-9A-Za-z_-]{20,}/, /sk-[a-zA-Z0-9-]{20,}/, /sk-ant-[a-zA-Z0-9-]{20,}/, /xai-[a-zA-Z0-9]{20,}/, /\bntn_[a-zA-Z0-9]{20,}/, /secret_[a-zA-Z0-9]{20,}/, /client_secret["'=:]/]) {
    assert.ok(!pattern.test(bundle), `the release bundle matches ${pattern}`)
  }
  assert.ok(!bundle.includes('oauth/token'), "Notion's confidential endpoint is never called from the extension")

  const maps = [...readdirSync(dir), ...(existsSync(join(dir, 'chunks')) ? readdirSync(join(dir, 'chunks')) : [])].filter((f) => f.endsWith('.map'))
  assert.deepEqual(maps, [], 'no source maps in a store package')
  assert.ok(!bundle.includes('sourceMappingURL'), 'no dangling source map references')
})

test('the release manifest allows exactly Brototype, Notion, Gemini and the deployed backend - nothing broader', { skip }, () => {
  const dir = existsSync(join(out, 'manifest.json')) ? out : buildRelease({})
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))

  assert.deepEqual([...manifest.host_permissions].sort(), [
    'https://*.brototype.com/*',
    'https://api.notion.com/*',
    'https://brototype.com/*',
    'https://generativelanguage.googleapis.com/*',
    `${PROD}/*`,
  ].sort())
  assert.ok(!manifest.optional_host_permissions)
  assert.ok(!manifest.permissions.includes('tabs'))
  assert.ok(manifest.permissions.includes('identity'), 'needed for the Notion sign-in window')
  assert.ok(manifest.key, 'the public key pins the extension id, so the Notion redirect URI is stable')
  assert.ok(!existsSync(join(dir, 'key.pem')), 'the private key is never in the package')
  assert.ok(!existsSync(join(dir, '.env')), 'no env file in the package')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(manifest.description.length <= 132, 'Web Store caps the description at 132 characters')
  for (const size of ['16', '48', '128']) assert.ok(existsSync(join(dir, manifest.icons[size])), `icon ${size}`)
})
