/**
 * Notion OAuth token exchange.
 *
 * This lives on the server for one reason: Notion's OAuth is a CONFIDENTIAL
 * client flow. https://api.notion.com/v1/oauth/token authenticates the caller
 * with HTTP Basic `client_id:client_secret` and Notion does not support PKCE
 * for integration authorisation, so there is no way for a browser extension to
 * complete the exchange on its own. Anything shipped inside a .crx is public.
 *
 * So the split is:
 *   extension  - opens the authorize page, receives the ?code, stores the token
 *   here       - swaps that code for a token using the secret, and nothing else
 *
 * The access token is handed back to the extension because that is where the
 * Notion API calls happen; the CLIENT SECRET never leaves this process.
 */

const TOKEN_URL = 'https://api.notion.com/v1/oauth/token'
const NOTION_VERSION = '2022-06-28'

export const clientId = () => process.env.NOTION_OAUTH_CLIENT_ID || ''
const clientSecret = () => process.env.NOTION_OAUTH_CLIENT_SECRET || ''
export const redirectUri = () => process.env.NOTION_OAUTH_REDIRECT_URI || ''

export const oauthConfigured = () => Boolean(clientId() && clientSecret() && redirectUri())

/** `message` is shown to the user; `detail` goes to the server log only. */
function fail(status, code, message, detail = '') {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (detail) error.detail = detail
  return error
}

/** Notion's OAuth errors are machine codes; turn them into a sentence. */
function describe(status, body) {
  const kind = body?.error || ''
  const detail = body?.error_description || ''

  if (kind === 'invalid_grant') {
    return fail(400, 'NOTION_OAUTH_CODE_EXPIRED',
      'That Notion authorisation has already been used or has expired. Press "Continue with Notion" again.')
  }
  if (kind === 'invalid_client' || status === 401) {
    return fail(500, 'NOTION_OAUTH_BAD_CLIENT',
      'Notion sign-in is not available right now. Please try again later.',
      'Notion rejected this server\'s OAuth credentials. Check NOTION_OAUTH_CLIENT_ID and NOTION_OAUTH_CLIENT_SECRET.')
  }
  if (kind === 'invalid_request') {
    return fail(400, 'NOTION_OAUTH_BAD_REQUEST',
      'Notion sign-in is not set up correctly. Please try again later.',
      `Notion rejected the authorisation request: ${detail || 'the redirect URI most likely does not match the one registered in the Notion integration.'}`)
  }
  return fail(status >= 500 ? 503 : 400, 'NOTION_OAUTH_FAILED',
    detail || `Notion returned HTTP ${status} during the token exchange.`)
}

async function tokenRequest(body) {
  if (!oauthConfigured()) {
    throw fail(500, 'NOTION_OAUTH_NOT_CONFIGURED',
      'Notion sign-in is not available yet.',
      'Set NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET and NOTION_OAUTH_REDIRECT_URI in the server environment and restart it.')
  }

  const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')
  let response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw fail(503, 'NOTION_OAUTH_UNREACHABLE', 'Notion could not be reached. Please try again.', 'This server could not reach api.notion.com.')
  }

  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw describe(response.status, json)
  if (!json.access_token) throw fail(502, 'NOTION_OAUTH_FAILED', 'Notion sign-in did not complete. Please try again.', 'Notion accepted the request but returned no access token.')
  return json
}

/** Shape the extension stores. Deliberately excludes anything it cannot use. */
const publicFields = (token) => ({
  accessToken: token.access_token,
  // Notion returns null here unless the integration uses token rotation.
  refreshToken: token.refresh_token || '',
  botId: token.bot_id || '',
  workspaceId: token.workspace_id || '',
  workspaceName: token.workspace_name || '',
  workspaceIcon: token.workspace_icon || '',
  ownerName: token.owner?.user?.name || '',
})

export async function exchangeCode(code, callerRedirectUri) {
  if (!code) throw fail(400, 'NOTION_OAUTH_NO_CODE', 'No authorisation code was sent to the exchange endpoint.')

  // The redirect URI is not a free parameter: Notion checks it against the one
  // registered for the integration, and accepting an arbitrary value here would
  // let a third party spend a code obtained for a different redirect.
  if (callerRedirectUri && callerRedirectUri !== redirectUri()) {
    throw fail(400, 'NOTION_OAUTH_REDIRECT_MISMATCH',
      'Notion sign-in is not set up correctly for this installation.',
      `This server is configured for the redirect URI ${redirectUri()}, but the extension used ${callerRedirectUri}. Register the extension's URI in Notion and put the same value in NOTION_OAUTH_REDIRECT_URI.`)
  }

  return publicFields(await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  }))
}

export async function refreshToken(token) {
  if (!token) throw fail(400, 'NOTION_OAUTH_NO_REFRESH_TOKEN', 'No refresh token was sent.')
  return publicFields(await tokenRequest({ grant_type: 'refresh_token', refresh_token: token }))
}
