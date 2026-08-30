import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The Notion sign-in, end to end, with only api.notion.com faked.
 *
 *   src/notion/oauth.js  --real HTTP-->  backend/src/index.js  -->  (stub Notion)
 *
 * The unit tests in notion-oauth.test.js stub the backend, so they cannot catch
 * the two things that actually broke in practice: a backend that is not there,
 * and a route contract that drifts between the two halves. This one starts the
 * real Express app on a port and makes the real fetch.
 *
 * Chrome is faked at exactly two points, because neither exists in Node:
 * chrome.identity (the sign-in window) and chrome.storage (the profile).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_ENTRY = resolve(ROOT, '../backend/src/index.js')
const hasBackend = existsSync(BACKEND_ENTRY) && existsSync(resolve(ROOT, '../backend/node_modules/express'))
const skip = !hasBackend && 'backend/ is not installed (npm install in backend/)'

const PORT = 8912
const BACKEND = `http://localhost:${PORT}`
const REDIRECT = 'https://abcdefghijklmno.chromiumapp.org/notion'
const CLIENT_ID = 'test-client-id'
const CLIENT_SECRET = 'test-client-secret'

process.env.PORT = String(PORT)
process.env.NOTION_OAUTH_CLIENT_ID = CLIENT_ID
process.env.NOTION_OAUTH_CLIENT_SECRET = CLIENT_SECRET
process.env.NOTION_OAUTH_REDIRECT_URI = REDIRECT

// --- the only fake network: Notion itself ---------------------------------
const realFetch = globalThis.fetch
let notionCalls = []
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.notion.com')) return realFetch(url, init)
  const body = init.body ? JSON.parse(init.body) : null
  notionCalls.push({ url: String(url), headers: init.headers, body })

  if (String(url).endsWith('/v1/pages')) {
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ id: 'created-page-id', url: 'https://notion.so/created-page-id' }) }
  }
  if (body.code === 'already-used') {
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'code already used' }) }
  }
  return { ok: true, status: 200, json: async () => ({
    access_token: 'ntn_live_token', token_type: 'bearer', refresh_token: null,
    bot_id: 'bot-1', workspace_id: 'ws-1', workspace_name: '📚 Study Space', workspace_icon: '📚',
    owner: { user: { name: 'Wasim' } },
  }) }
}

// --- the only fake browser: identity + storage ----------------------------
const session = new Map()
const localStore = new Map()
let openedAuthUrl = null
let notionBehaviour = 'approve'

globalThis.chrome = {
  identity: {
    getRedirectURL: (p) => `https://abcdefghijklmno.chromiumapp.org/${p}`,
    launchWebAuthFlow: async ({ url }) => {
      openedAuthUrl = url
      const state = new URL(url).searchParams.get('state')
      switch (notionBehaviour) {
        case 'deny': return `${REDIRECT}?error=access_denied&error_description=User+denied`
        case 'close': throw new Error('The user did not approve access.')
        case 'wrong-state': return `${REDIRECT}?code=c1&state=tampered`
        case 'no-code': return `${REDIRECT}?state=${state}`
        case 'reuse': return `${REDIRECT}?code=already-used&state=${state}`
        default: return `${REDIRECT}?code=auth-code-xyz&state=${state}`
      }
    },
  },
  storage: {
    session: {
      get: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, v) },
      remove: async (k) => { session.delete(k) },
    },
    local: {
      get: async (k) => (localStore.has(k) ? { [k]: localStore.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) localStore.set(k, v) },
    },
  },
}

let server, authorize, withNotionAuth, getConfig, setConfig, resolveNotionToken, notionAuthMethod, resolveBackendUrl
let createDestinationPage, configStatus

if (hasBackend) {
  // The console banner would drown the test output.
  const log = console.log
  console.log = () => {}
  ;({ server } = await import(pathToFileURL(BACKEND_ENTRY).href))
  await new Promise((r) => server.once('listening', r) || setTimeout(r, 300))
  console.log = log

  ;({ authorize, withNotionAuth } = await import('../src/notion/oauth.js'))
  ;({ createDestinationPage } = await import('../src/notion/pages.js'))
  ;({ configStatus } = await import('../src/lib/storage.js'))
  ;({ getConfig, setConfig, resolveNotionToken, notionAuthMethod } = await import('../src/lib/storage.js'))
  ;({ resolveBackendUrl } = await import('../src/lib/env.js'))
  after(() => server.close())
}

const reset = () => {
  session.clear(); localStore.clear(); notionCalls = []
  notionBehaviour = 'approve'
  // The Advanced override, which is also how a dev points at a scratch server.
  localStore.set('config', { notionOAuthBackendUrl: BACKEND })
}

test('the running backend advertises its OAuth config without leaking the secret', { skip }, async () => {
  reset()
  const health = await realFetch(`${BACKEND}/health`).then((r) => r.json())
  assert.equal(health.notionOAuth, true)

  const config = await realFetch(`${BACKEND}/notion/oauth/config`).then((r) => r.json())
  assert.deepEqual(config, { configured: true, clientId: CLIENT_ID, redirectUri: REDIRECT })
  assert.ok(!JSON.stringify(config).includes(CLIENT_SECRET), 'the client secret must never leave the server')
})

test('"Continue with Notion" runs the whole chain and comes back connected', { skip }, async () => {
  reset()
  assert.equal(resolveBackendUrl(await getConfig()), BACKEND, 'the override decides which server is used')

  const auth = await authorize(resolveBackendUrl(await getConfig()))

  // What Chrome was asked to open.
  const url = new URL(openedAuthUrl)
  assert.equal(url.origin + url.pathname, 'https://api.notion.com/v1/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('owner'), 'user')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT)

  // What the backend did with the code, over a real HTTP hop.
  assert.equal(notionCalls.length, 1)
  assert.equal(notionCalls[0].headers.Authorization,
    `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`)
  assert.equal(notionCalls[0].body.grant_type, 'authorization_code')
  assert.equal(notionCalls[0].body.redirect_uri, REDIRECT)

  // What the extension ended up holding.
  assert.equal(auth.accessToken, 'ntn_live_token')
  assert.equal(auth.workspaceName, '📚 Study Space')
})

test('the connection is then what page search uses, with no second sign-in', { skip }, async () => {
  reset()
  await setConfig({ notionAuth: await authorize(BACKEND) })

  const config = await getConfig()
  assert.equal(notionAuthMethod(config), 'oauth')
  assert.equal(resolveNotionToken(config), 'ntn_live_token')

  let usedToken = null
  const result = await withNotionAuth(async (token) => { usedToken = token; return { results: [{ id: 'p1' }, { id: 'p2' }] } })
  assert.equal(usedToken, 'ntn_live_token')
  assert.equal(result.results.length, 2)
})

test('reconnecting swaps the token and keeps the chosen page', { skip }, async () => {
  reset()
  localStore.set('config', { notionOAuthBackendUrl: BACKEND, notionAuth: { accessToken: 'ntn_old' }, notionParentId: 'p1', notionParentTitle: 'Notes' })
  await setConfig({ notionAuth: await authorize(BACKEND) })

  const config = await getConfig()
  assert.equal(resolveNotionToken(config), 'ntn_live_token')
  assert.equal(config.notionParentId, 'p1')
})

test('disconnecting clears the local connection and touches nothing in Notion', { skip }, async () => {
  reset()
  await setConfig({ notionAuth: await authorize(BACKEND), notionParentId: 'p1', notionParentTitle: 'Notes' })
  const callsBefore = notionCalls.length

  await setConfig({ notionAuth: null, notionParentId: '', notionParentTitle: '' })

  const config = await getConfig()
  assert.equal(notionAuthMethod(config), 'none')
  assert.equal(resolveNotionToken(config), '')
  assert.equal(config.notionParentId, '')
  assert.equal(notionCalls.length, callsBefore, 'disconnecting must not call Notion at all')
})

test('every way the sign-in can fail reaches the user as its own message', { skip }, async () => {
  const cases = [
    ['deny', 'NOTION_OAUTH_CANCELLED'],
    ['close', 'NOTION_OAUTH_CANCELLED'],
    ['wrong-state', 'NOTION_OAUTH_BAD_STATE'],
    ['no-code', 'NOTION_OAUTH_NO_CODE'],
    ['reuse', 'NOTION_OAUTH_CODE_EXPIRED'],   // this one comes back from the real backend
  ]
  for (const [behaviour, code] of cases) {
    reset()
    notionBehaviour = behaviour
    await assert.rejects(() => authorize(BACKEND), (e) => {
      assert.equal(e.code, code, `${behaviour} should be ${code}, got ${e.code}`)
      assert.ok(e.message.length > 10, `${behaviour} needs a real sentence, got "${e.message}"`)
      return true
    })
  }
})

test('a sign-in server that is not running is a service outage, not a stack trace', { skip }, async () => {
  reset()
  // Port 9 is the discard port: nothing listens, so the connection is refused.
  await assert.rejects(() => authorize('http://localhost:9'), (e) => {
    assert.equal(e.code, 'NOTION_SERVICE_UNAVAILABLE')
    assert.equal(e.message, 'Notion connection service is unavailable.')
    assert.ok(e.retryable, 'the UI offers Try again, so this must be retryable')
    assert.ok(!/npm|\.env|ECONNREFUSED/.test(e.message), 'the message stays clean; the URL lives in detail')
    return true
  })
})

test('a running backend with no Notion credentials still fails politely', { skip }, async () => {
  reset()
  const saved = process.env.NOTION_OAUTH_CLIENT_ID
  process.env.NOTION_OAUTH_CLIENT_ID = ''    // the server reads env per request
  try {
    await assert.rejects(() => authorize(BACKEND), (e) => {
      assert.equal(e.code, 'NOTION_OAUTH_NOT_CONFIGURED')
      assert.ok(!/NOTION_OAUTH|environment/.test(e.message), 'the user is not shown server configuration')
      assert.ok(/NOTION_OAUTH_CLIENT_SECRET/.test(e.detail), 'but the developer is')
      return true
    })
  } finally {
    process.env.NOTION_OAUTH_CLIENT_ID = saved
  }
})

test('connect -> create the destination -> ready to generate, with no manual Notion work', { skip }, async () => {
  reset()

  // 1. Continue with Notion
  await setConfig({ notionAuth: await authorize(BACKEND) })
  assert.equal(configStatus(await getConfig()).notionConnected, true)
  assert.equal(configStatus(await getConfig()).notionParentChosen, false, 'nowhere to write yet')

  // 2. Create New Page — exactly what the worker's CREATE_NOTION_PAGE does
  const page = await withNotionAuth((token) => createDestinationPage(token, '📚 Brototype Notes'))
  await setConfig({ notionParentId: page.id, notionParentTitle: '📚 Brototype Notes' })

  const createCall = notionCalls.find((c) => c.url.endsWith('/v1/pages'))
  assert.deepEqual(createCall.body.parent, { type: 'workspace', workspace: true })
  assert.equal(createCall.headers.Authorization, 'Bearer ntn_live_token', 'created with the OAuth token')

  // 3. The destination is selected automatically, so Generate is unblocked
  const config = await getConfig()
  assert.equal(config.notionParentId, 'created-page-id')
  assert.equal(config.notionParentTitle, '📚 Brototype Notes')
  assert.equal(configStatus(config).notionParentChosen, true)

  // 4. And the user never had to open Notion, share a page, or paste a token
  assert.equal(config.notionToken, '', 'no integration secret was involved')
})
