/**
 * The Notion OAuth flow, as run by the service worker.
 *
 * WHY THERE IS A BACKEND IN HERE. Notion's authorisation code is exchanged at
 * https://api.notion.com/v1/oauth/token, which authenticates the caller with
 * HTTP Basic `client_id:client_secret`. Notion does not offer PKCE for
 * integration authorisation, so there is no variant of this flow a public
 * client can finish alone. A secret compiled into an extension is not a secret
 * - anyone can unzip a .crx - so the exchange happens in backend/, and the
 * extension only ever handles the resulting access token.
 *
 *   extension: open authorize page  ->  receive ?code  ->  POST code to backend
 *   backend:   code + secret        ->  Notion         ->  access token back
 *
 * THE REDIRECT. chrome.identity.launchWebAuthFlow opens the page in a managed
 * window and closes it the moment Notion redirects to
 * https://<extension-id>.chromiumapp.org/... - no localhost listener, no
 * separate tab to clean up. That URL must be registered in the Notion
 * integration verbatim; Notion does not pattern-match redirect URIs.
 */

import { AppError, errors } from '../lib/errors.js'
import { getConfig, setConfig, resolveNotionToken } from '../lib/storage.js'
import { resolveBackendUrl } from '../lib/env.js'

const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const STATE_KEY = 'notionOAuthState'

/** The one redirect URI this installation can ever use. */
export const redirectUri = () => chrome.identity.getRedirectURL('notion')

const base = (url) => (url || '').trim().replace(/\/$/, '')

/**
 * The user did nothing wrong and can do nothing about the server, so the
 * message says the one true thing and stops. Which server, and why it did not
 * answer, goes in `detail`, which the UI only shows on a development build.
 */
function unreachable(backendUrl, cause) {
  return new AppError('NOTION_SERVICE_UNAVAILABLE',
    'Notion connection service is unavailable.',
    { retryable: true, cause, detail: `No answer from ${backendUrl}` })
}

/** Read the public half of the OAuth configuration from the backend. */
async function fetchOAuthConfig(backendUrl) {
  let response
  try {
    response = await fetch(`${base(backendUrl)}/notion/oauth/config`)
  } catch (error) {
    throw unreachable(backendUrl, error)
  }
  if (!response.ok) {
    throw new AppError('NOTION_OAUTH_BACKEND_ERROR',
      'Notion connection service is unavailable.',
      { retryable: true, detail: `${base(backendUrl)} answered HTTP ${response.status} instead of its Notion OAuth settings` })
  }
  const json = await response.json().catch(() => ({}))
  if (!json.configured || !json.clientId) {
    throw new AppError('NOTION_OAUTH_NOT_CONFIGURED',
      'Notion sign-in is not available yet.',
      { detail: 'The sign-in server is running but has no Notion OAuth credentials. Set NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET and NOTION_OAUTH_REDIRECT_URI in the server environment and restart it.' })
  }
  return json
}

/**
 * A random, single-use value echoed back by Notion. If what comes back is not
 * what we sent, the response did not originate from the request we made, and
 * the code is thrown away rather than spent. Kept in session storage because
 * Chrome may recycle the service worker while the user is typing a password.
 */
async function issueState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  await chrome.storage.session.set({ [STATE_KEY]: state })
  return state
}

async function consumeState() {
  const stored = await chrome.storage.session.get(STATE_KEY)
  await chrome.storage.session.remove(STATE_KEY)
  return stored[STATE_KEY] || ''
}

/** Notion sends the outcome back as query parameters on the redirect URL. */
function readCallback(callbackUrl) {
  let params
  try {
    params = new URL(callbackUrl).searchParams
  } catch {
    throw new AppError('NOTION_OAUTH_BAD_CALLBACK', 'Notion sent back something this extension could not read. Try connecting again.')
  }

  const error = params.get('error')
  if (error) {
    if (error === 'access_denied') {
      throw new AppError('NOTION_OAUTH_CANCELLED', 'You did not finish authorising Notion, so nothing was connected.')
    }
    throw new AppError('NOTION_OAUTH_DENIED',
      `Notion refused the authorisation (${error}). ${params.get('error_description') || ''}`.trim())
  }

  return { code: params.get('code') || '', state: params.get('state') || '' }
}

/** Chrome's own failures, which arrive as a plain message, not a status code. */
function readLaunchError(message) {
  const text = String(message || '')
  if (/user did not approve|canceled|cancelled|closed by the user/i.test(text)) {
    return new AppError('NOTION_OAUTH_CANCELLED', 'The Notion sign-in window was closed before you approved access.')
  }
  return new AppError('NOTION_OAUTH_WINDOW_FAILED',
    `Chrome could not complete the Notion sign-in window. ${text}`.trim(), { retryable: true })
}

async function postToBackend(backendUrl, path, body) {
  let response
  try {
    response = await fetch(`${base(backendUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw unreachable(backendUrl, error)
  }

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new AppError(json.code || 'NOTION_OAUTH_EXCHANGE_FAILED',
      json.message || `The sign-in server could not complete the Notion exchange (HTTP ${response.status}).`,
      { retryable: response.status >= 500 })
  }
  if (!json.accessToken) {
    throw new AppError('NOTION_OAUTH_EXCHANGE_FAILED', 'The sign-in server returned no Notion access token.')
  }
  return json
}

/** What the extension stores. No token ever reaches a log line. */
const toStoredAuth = (result) => ({
  accessToken: result.accessToken,
  refreshToken: result.refreshToken || '',
  workspaceName: result.workspaceName || '',
  workspaceIcon: result.workspaceIcon || '',
  workspaceId: result.workspaceId || '',
  botId: result.botId || '',
  ownerName: result.ownerName || '',
  connectedAt: Date.now(),
})

/**
 * The whole flow. Resolves with the object to store under `notionAuth`, or
 * throws an AppError whose message says what to do next.
 */
export async function authorize(backendUrl) {
  const config = await fetchOAuthConfig(backendUrl)
  const mine = redirectUri()

  // Caught here rather than by hanging on a window that will never redirect:
  // if these differ, Notion redirects somewhere Chrome is not watching.
  if (config.redirectUri !== mine) {
    throw new AppError('NOTION_OAUTH_REDIRECT_MISMATCH',
      'Notion sign-in is not set up correctly for this installation.',
      { detail: `This extension redirects to ${mine}, but the sign-in server is configured for ${config.redirectUri}. Register ${mine} in the Notion integration's Redirect URIs and set NOTION_OAUTH_REDIRECT_URI to the same value.` })
  }

  const state = await issueState()
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: mine,
    state,
  })}`

  let callbackUrl
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true })
  } catch (error) {
    await chrome.storage.session.remove(STATE_KEY)
    throw readLaunchError(error?.message)
  }
  // Chrome resolves with undefined instead of rejecting in some closed-window
  // cases, so an empty result is a cancellation, not a success.
  if (!callbackUrl) {
    await chrome.storage.session.remove(STATE_KEY)
    throw new AppError('NOTION_OAUTH_CANCELLED', 'The Notion sign-in window was closed before you approved access.')
  }

  const expected = await consumeState()
  const { code, state: returned } = readCallback(callbackUrl)

  if (!expected || returned !== expected) {
    throw new AppError('NOTION_OAUTH_BAD_STATE',
      'The reply from Notion did not match the sign-in this extension started, so it was discarded. Press "Continue with Notion" again.')
  }
  if (!code) {
    throw new AppError('NOTION_OAUTH_NO_CODE', 'Notion returned no authorisation code. Press "Continue with Notion" again.')
  }

  return toStoredAuth(await postToBackend(backendUrl, '/notion/oauth/exchange', { code, redirectUri: mine }))
}

/**
 * Swap a refresh token for a fresh access token. Notion only issues refresh
 * tokens to integrations that use token rotation, so this returns null when
 * there is nothing to refresh - the caller then asks the user to reconnect.
 */
export async function refresh(backendUrl, auth) {
  if (!auth?.refreshToken) return null
  const result = await postToBackend(backendUrl, '/notion/oauth/refresh', { refreshToken: auth.refreshToken })
  return { ...auth, ...toStoredAuth(result), connectedAt: auth.connectedAt }
}

/**
 * Run a Notion call with whatever credentials are stored, and survive one
 * expired access token: if Notion answers 401 and a refresh token exists, the
 * token is renewed once and the call is retried. When it cannot be renewed the
 * error says "reconnect", which is the only thing the user can act on.
 *
 * Pasted integration secrets (the pre-OAuth path) never expire and have nothing
 * to refresh, so for those this is just "call it and report the error".
 */
export async function withNotionAuth(run) {
  const config = await getConfig()
  const token = resolveNotionToken(config)
  if (!token) throw errors.notionNotConnected()

  try {
    return await run(token)
  } catch (error) {
    const appError = AppError.from(error)
    if (appError.code !== 'NOTION_UNAUTHORIZED') throw appError

    let renewed = null
    try {
      renewed = await refresh(resolveBackendUrl(config), config.notionAuth)
    } catch {
      renewed = null // the reconnect message below is more useful than a refresh failure
    }
    if (!renewed) throw errors.notionReconnect()

    await setConfig({ notionAuth: renewed })
    return run(renewed.accessToken)
  }
}
