import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The OAuth flow, run against a fake Chrome and a fake network.
 *
 * The properties worth pinning are the ones a browser test would never fail
 * loudly on: that a mismatched `state` is refused rather than spent, that a
 * closed window reads as a cancellation rather than a crash, and that the
 * client secret has nowhere to be, because the exchange is a backend call.
 */

const session = new Map()
const local = new Map()

let launch = async () => ''
let network = async () => ({ ok: true, status: 200, json: {} })

globalThis.chrome = {
  identity: {
    getRedirectURL: (path) => `https://abcdefghij.chromiumapp.org/${path}`,
    launchWebAuthFlow: (...args) => launch(...args),
  },
  storage: {
    session: {
      get: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, v) },
      remove: async (k) => { session.delete(k) },
    },
    local: {
      get: async (k) => (local.has(k) ? { [k]: local.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) local.set(k, v) },
    },
  },
}

let requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
  const result = await network(url, init)
  if (result instanceof Error) throw result
  return {
    ok: result.ok,
    status: result.status,
    json: async () => result.json,
  }
}

const { authorize, redirectUri, withNotionAuth } = await import('../src/notion/oauth.js')
const { getConfig, setConfig, resolveNotionToken, notionAuthMethod, DEFAULT_CONFIG } = await import('../src/lib/storage.js')

const REDIRECT = 'https://abcdefghij.chromiumapp.org/notion'
const BACKEND = 'http://localhost:8787'

/** The happy path unless a test overrides one leg of it. */
function stubNetwork({ config, exchange } = {}) {
  network = async (url) => {
    if (url.endsWith('/notion/oauth/config')) {
      return { ok: true, status: 200, json: config ?? { configured: true, clientId: 'client-abc', redirectUri: REDIRECT } }
    }
    if (url.endsWith('/notion/oauth/exchange')) {
      return exchange ?? { ok: true, status: 200, json: { accessToken: 'ntn_from_oauth', refreshToken: '', workspaceName: 'Study', workspaceId: 'w1', botId: 'b1' } }
    }
    if (url.endsWith('/notion/oauth/refresh')) {
      return { ok: true, status: 200, json: { accessToken: 'ntn_refreshed', refreshToken: 'r2' } }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
}

/** Reply the way Notion does: echo the state it was given. */
const echoState = (extra = '') => async ({ url }) => {
  const state = new URL(url).searchParams.get('state')
  return `${REDIRECT}?code=auth-code-1&state=${state}${extra}`
}

test.beforeEach(() => {
  session.clear(); local.clear(); requests = []
  stubNetwork()
  launch = echoState()
})

test('the redirect URI is Chrome\'s own, so no localhost listener is involved', () => {
  assert.equal(redirectUri(), REDIRECT)
  assert.ok(redirectUri().startsWith('https://'), 'Notion only accepts https redirect URIs')
})

test('a successful authorisation asks Notion for a code, then the backend for a token', async () => {
  const auth = await authorize(BACKEND)

  assert.equal(auth.accessToken, 'ntn_from_oauth')
  assert.equal(auth.workspaceName, 'Study')
  assert.ok(auth.connectedAt > 0)

  const exchange = requests.find((r) => r.url.endsWith('/notion/oauth/exchange'))
  assert.equal(exchange.method, 'POST')
  assert.deepEqual(exchange.body, { code: 'auth-code-1', redirectUri: REDIRECT })
})

/** Captured separately because launchWebAuthFlow is not a fetch. */
let lastAuthorizeUrl = ''

test('the authorize URL carries exactly the parameters Notion documents', async () => {
  launch = async ({ url, interactive }) => {
    lastAuthorizeUrl = url
    assert.equal(interactive, true, 'the user must be able to see and approve the page')
    return echoState()({ url })
  }
  await authorize(BACKEND)

  const url = new URL(lastAuthorizeUrl)
  assert.equal(url.origin + url.pathname, 'https://api.notion.com/v1/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), 'client-abc')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('owner'), 'user')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT)
  assert.ok((url.searchParams.get('state') || '').length >= 32, 'state must be long enough to be unguessable')
})

test('each attempt uses a fresh state', async () => {
  const seen = new Set()
  launch = async ({ url }) => { seen.add(new URL(url).searchParams.get('state')); return echoState()({ url }) }
  await authorize(BACKEND)
  await authorize(BACKEND)
  assert.equal(seen.size, 2)
})

test('a reply whose state does not match is discarded, and the code is never spent', async () => {
  launch = async () => `${REDIRECT}?code=attacker-code&state=not-the-one-we-sent`
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_BAD_STATE')
  assert.ok(!requests.some((r) => r.url.endsWith('/exchange')), 'the code must not reach the token exchange')
})

test('a state that was never issued is refused too', async () => {
  launch = async () => { session.clear(); return `${REDIRECT}?code=c&state=` }
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_BAD_STATE')
})

test('the state is single-use: a replayed callback cannot be exchanged again', async () => {
  let captured = ''
  launch = async ({ url }) => { captured = await echoState()({ url }); return captured }
  await authorize(BACKEND)

  launch = async () => captured                 // same URL, same state, second time
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_BAD_STATE')
})

test('the user pressing Cancel in Notion is a cancellation, not an error', async () => {
  launch = async () => `${REDIRECT}?error=access_denied&error_description=User+denied`
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_CANCELLED')
})

test('closing the sign-in window is a cancellation, however Chrome reports it', async () => {
  launch = async () => { throw new Error('The user did not approve access.') }
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_CANCELLED')

  launch = async () => undefined // Chrome sometimes resolves empty instead of rejecting
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_CANCELLED')
})

test('any other Notion refusal names itself instead of failing silently', async () => {
  launch = async () => `${REDIRECT}?error=invalid_request&error_description=Bad+redirect`
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_DENIED' && /Bad redirect/.test(e.message))
})

test('a callback with no code at all is reported, not treated as success', async () => {
  launch = async ({ url }) => `${REDIRECT}?state=${new URL(url).searchParams.get('state')}`
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_NO_CODE')
})

test('a redirect URI the backend does not expect is caught before the window opens', async () => {
  stubNetwork({ config: { configured: true, clientId: 'c', redirectUri: 'https://other.chromiumapp.org/notion' } })
  let opened = false
  launch = async () => { opened = true; return '' }

  await assert.rejects(() => authorize(BACKEND), (e) =>
    e.code === 'NOTION_OAUTH_REDIRECT_MISMATCH' && e.detail.includes(REDIRECT))
  assert.equal(opened, false, 'no point opening a window Notion will redirect away from')
})

test('a backend with no OAuth credentials keeps the fix in detail, not in the user\'s face', async () => {
  stubNetwork({ config: { configured: false, clientId: '', redirectUri: '' } })
  await assert.rejects(() => authorize(BACKEND), (e) =>
    e.code === 'NOTION_OAUTH_NOT_CONFIGURED'
    && !/\.env|CLIENT_SECRET/.test(e.message)      // the message a normal user reads
    && /NOTION_OAUTH_CLIENT_SECRET/.test(e.detail))  // the line a developer needs
})

test('an unreachable backend reads as a service outage, is retryable, and names no URL to the user', async () => {
  network = async () => new TypeError('fetch failed')
  await assert.rejects(() => authorize(BACKEND), (e) =>
    e.code === 'NOTION_SERVICE_UNAVAILABLE'
    && e.message === 'Notion connection service is unavailable.'
    && !e.message.includes('localhost') && !e.message.includes('npm')
    && e.detail.includes(BACKEND)
    && e.retryable)
})

test('a sign-in server that answers with an error page is the same kind of outage', async () => {
  network = async () => ({ ok: false, status: 502, json: {} })
  await assert.rejects(() => authorize(BACKEND), (e) =>
    e.code === 'NOTION_OAUTH_BACKEND_ERROR' && e.message === 'Notion connection service is unavailable.' && e.detail.includes('502'))
})

test('a failed token exchange surfaces the backend\'s own explanation', async () => {
  stubNetwork({ exchange: { ok: false, status: 400, json: { code: 'NOTION_OAUTH_CODE_EXPIRED', message: 'That Notion authorisation has expired.' } } })
  await assert.rejects(() => authorize(BACKEND), (e) =>
    e.code === 'NOTION_OAUTH_CODE_EXPIRED' && /expired/.test(e.message))
})

test('an exchange that returns no token is a failure, not an empty connection', async () => {
  stubNetwork({ exchange: { ok: true, status: 200, json: { workspaceName: 'Study' } } })
  await assert.rejects(() => authorize(BACKEND), (e) => e.code === 'NOTION_OAUTH_EXCHANGE_FAILED')
})

test('no client secret is ever sent from the extension', async () => {
  await authorize(BACKEND)
  const sent = JSON.stringify(requests)
  assert.ok(!/client_secret|clientSecret|Basic /.test(sent), 'the secret belongs to the backend alone')
})

// --- which credentials get used ------------------------------------------

test('OAuth wins over a pasted secret, and neither is deleted by the other', () => {
  const pasted = { ...DEFAULT_CONFIG, notionToken: 'ntn_pasted' }
  assert.equal(resolveNotionToken(pasted), 'ntn_pasted')
  assert.equal(notionAuthMethod(pasted), 'token')

  const both = { ...pasted, notionAuth: { accessToken: 'ntn_oauth' } }
  assert.equal(resolveNotionToken(both), 'ntn_oauth')
  assert.equal(notionAuthMethod(both), 'oauth')
  assert.equal(both.notionToken, 'ntn_pasted', 'the old secret is still there to fall back on')

  assert.equal(resolveNotionToken(DEFAULT_CONFIG), '')
  assert.equal(notionAuthMethod(DEFAULT_CONFIG), 'none')
})

test('a Notion call that 401s is retried once with a refreshed token', async () => {
  local.set('config', { ...DEFAULT_CONFIG, notionAuth: { accessToken: 'ntn_stale', refreshToken: 'r1' } })

  const tokensTried = []
  const result = await withNotionAuth(async (token) => {
    tokensTried.push(token)
    if (token === 'ntn_stale') throw { code: 'NOTION_UNAUTHORIZED', message: 'expired' }
    return 'ok'
  })

  assert.equal(result, 'ok')
  assert.deepEqual(tokensTried, ['ntn_stale', 'ntn_refreshed'])
  assert.equal((await getConfig()).notionAuth.accessToken, 'ntn_refreshed', 'the new token is saved')
})

test('a 401 with nothing to refresh asks the user to reconnect', async () => {
  local.set('config', { ...DEFAULT_CONFIG, notionToken: 'ntn_pasted' })
  await assert.rejects(
    () => withNotionAuth(async () => { throw { code: 'NOTION_UNAUTHORIZED', message: 'nope' } }),
    (e) => e.code === 'NOTION_UNAUTHORIZED' && /Reconnect Notion/.test(e.message),
  )
})

test('errors that are not authentication problems pass straight through', async () => {
  local.set('config', { ...DEFAULT_CONFIG, notionToken: 'ntn_pasted' })
  await assert.rejects(
    () => withNotionAuth(async () => { throw { code: 'NOTION_NOT_SHARED', message: 'not shared' } }),
    (e) => e.code === 'NOTION_NOT_SHARED',
  )
})

test('with no credentials at all, nothing is attempted', async () => {
  local.set('config', { ...DEFAULT_CONFIG })
  let called = false
  await assert.rejects(
    () => withNotionAuth(async () => { called = true }),
    (e) => e.code === 'NOTION_NOT_CONNECTED',
  )
  assert.equal(called, false)
})

// --- which sign-in server this build talks to ------------------------------

const { DEFAULT_BACKEND_URL, IS_DEV_BUILD, acceptableOverride, resolveBackendUrl } = await import('../src/lib/env.js')
const { migrateConfig } = await import('../src/lib/storage.js')

test('an unbuilt module is a development build talking to the local server, so tests and Node never see undefined', () => {
  assert.equal(DEFAULT_BACKEND_URL, 'http://localhost:8787')
  assert.equal(IS_DEV_BUILD, true)
})

test('a development build accepts any override; a release build only accepts https (checked by the release-build test)', () => {
  assert.equal(acceptableOverride('http://localhost:9000'), 'http://localhost:9000')
  assert.equal(acceptableOverride('  https://mine.example  '), 'https://mine.example')
  assert.equal(acceptableOverride(''), '')
  assert.equal(acceptableOverride(null), '')
})

test('an empty override means "this build\'s own server", not "no server"', () => {
  assert.equal(resolveBackendUrl({ notionOAuthBackendUrl: '' }), DEFAULT_BACKEND_URL)
  assert.equal(resolveBackendUrl({ notionOAuthBackendUrl: '   ' }), DEFAULT_BACKEND_URL)
  assert.equal(resolveBackendUrl({}), DEFAULT_BACKEND_URL)
  assert.equal(resolveBackendUrl(null), DEFAULT_BACKEND_URL)
  assert.equal(resolveBackendUrl({ notionOAuthBackendUrl: 'https://mine.example' }), 'https://mine.example')
})

test('a stored localhost left by an earlier release cannot pin a build to it', () => {
  const stored = { ai: { providers: {}, backendUrl: 'http://localhost:8787' }, notionOAuthBackendUrl: 'http://localhost:8787', notionToken: 'ntn_keep' }
  const migrated = migrateConfig(stored)
  assert.equal(migrated.notionOAuthBackendUrl, '', 'the dev literal is dropped so the build default applies')
  assert.equal(migrated.ai.backendUrl, '', 'the AI server literal too')
  assert.equal(migrated.notionToken, 'ntn_keep', 'and nothing else is touched')

  // A URL the user genuinely chose is theirs, and survives.
  assert.equal(migrateConfig({ ai: { providers: {} }, notionOAuthBackendUrl: 'https://mine.example' }).notionOAuthBackendUrl, 'https://mine.example')
})

// --- the whole round trip -------------------------------------------------

test('after connecting, the stored token is what the next Notion call uses', async () => {
  local.set('config', { ...DEFAULT_CONFIG })

  // 1. connect, exactly as the worker's NOTION_CONNECT handler does
  const auth = await authorize(resolveBackendUrl(await getConfig()))
  await setConfig({ notionAuth: auth })

  // 2. the config now reports a connection
  const config = await getConfig()
  assert.equal(notionAuthMethod(config), 'oauth')
  assert.equal(resolveNotionToken(config), 'ntn_from_oauth')

  // 3. and a page search runs with that token, without another sign-in
  const pages = await withNotionAuth(async (token) => {
    assert.equal(token, 'ntn_from_oauth')
    return { results: [{ id: 'p1' }] }
  })
  assert.equal(pages.results.length, 1)
})

test('reconnecting replaces the old token and keeps the chosen page', async () => {
  local.set('config', {
    ...DEFAULT_CONFIG,
    notionAuth: { accessToken: 'ntn_old', refreshToken: '' },
    notionParentId: 'page-1', notionParentTitle: 'Brototype Notes',
  })
  await setConfig({ notionAuth: await authorize(BACKEND) })

  const config = await getConfig()
  assert.equal(resolveNotionToken(config), 'ntn_from_oauth')
  assert.equal(config.notionParentId, 'page-1', 'reconnecting is not a reason to forget where notes go')
})

test('disconnecting clears the connection and the page, and deletes nothing else', async () => {
  local.set('config', {
    ...DEFAULT_CONFIG,
    notionAuth: { accessToken: 'ntn_oauth' },
    notionParentId: 'page-1', notionParentTitle: 'Notes',
    duplicateStrategy: 'new',
  })
  // exactly the patch the worker's NOTION_DISCONNECT applies for an OAuth login
  await setConfig({ notionAuth: null, notionParentId: '', notionParentTitle: '' })

  const config = await getConfig()
  assert.equal(notionAuthMethod(config), 'none')
  assert.equal(resolveNotionToken(config), '')
  assert.equal(config.notionParentId, '')
  assert.equal(config.duplicateStrategy, 'new', 'unrelated settings survive a disconnect')
})
