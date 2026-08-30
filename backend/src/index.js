/**
 * The shared backend. One deployment serves every installed copy of the
 * extension; it is the only place any secret lives.
 *
 * It does exactly two jobs, and holds NO per-user state for either:
 *
 *   1. Notion OAuth token exchange - the extension sends the one-time `code`,
 *      this server swaps it for a token using the client secret, and hands the
 *      token straight back. It is never stored here. Each user's token lives in
 *      that user's own chrome.storage, so one user cannot reach another's.
 *
 *   2. AI generation - the extension sends the prompt and one of the known
 *      output schemas; this server calls the provider with the key from its own
 *      environment and returns the structured result.
 *
 * Because there is no session and no database, "user isolation" is not a
 * feature that can regress: there is nothing shared to leak.
 *
 * Local development:   cp .env.example .env && npm install && npm start
 * Production (Render): environment variables from the dashboard, `npm start`,
 *                      health check on GET /health.
 */

import express from 'express'
import { resolve, getAdapter, configuredProviders, defaultProviderId } from './providers.js'
import { clientId, redirectUri, oauthConfigured, exchangeCode, refreshToken } from './notion-oauth.js'
import { isKnownSchema } from './schemas.js'

const app = express()
export const PORT = Number(process.env.PORT) || 8787
const HOST = '0.0.0.0'
const isProduction = process.env.NODE_ENV === 'production'

// Render (and every other PaaS) sits behind a reverse proxy, so req.ip would
// otherwise be the proxy for everyone and the rate limiter would treat all
// users as one client.
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

// --- CORS -------------------------------------------------------------------
// Only the extension may call this from a browser. Requests carry no cookies
// and no credentials, so a mirrored Origin is safe; it is still restricted to
// chrome-extension:// origins, and to the published extension's own id when
// ALLOWED_EXTENSION_IDS is set (the production setting).
const allowedExtensionIds = (process.env.ALLOWED_EXTENSION_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)

export function originAllowed(origin) {
  if (!origin) return true // curl, health checks, server-to-server: no CORS involved
  if (!origin.startsWith('chrome-extension://')) return false
  if (!allowedExtensionIds.length) return true
  return allowedExtensionIds.includes(origin.slice('chrome-extension://'.length))
}

app.use((req, res, next) => {
  const origin = req.headers.origin || ''
  res.setHeader('Vary', 'Origin')
  if (origin && !originAllowed(origin)) {
    // A browser page that is not the extension. No CORS headers means the
    // browser blocks the response; the 403 makes the reason visible in devtools.
    return res.status(403).json({ code: 'FORBIDDEN_ORIGIN', message: 'This service only serves the Brototype AI Notes extension.' })
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// --- rate limit -------------------------------------------------------------
// Per client IP, so one runaway or abusive client cannot burn the whole AI
// quota for everybody. A normal run makes well under this many calls a minute.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 30
const hits = new Map()
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  const now = Date.now()
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60_000)
  if (recent.length >= RATE_LIMIT) {
    return res.status(429).json({ code: 'AI_RATE_LIMIT', retryable: true, message: 'Too many requests. Please wait a minute and try again.' })
  }
  recent.push(now)
  hits.set(req.ip, recent)
  next()
})
// Forget idle clients so the map cannot grow without bound.
const sweep = setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [ip, times] of hits) if (!times.some((t) => t > cutoff)) hits.delete(ip)
}, 5 * 60_000)
sweep.unref()

// --- logging ----------------------------------------------------------------
// Method, path, status, duration. Never bodies, never headers: request bodies
// carry OAuth codes and prompts, and responses carry Notion tokens.
app.use((req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    if (req.path === '/health') return
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`)
  })
  next()
})

/** Liveness for Render, plus what the extension's "Test connection" wants to know. */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    aiConfigured: configuredProviders().length > 0,
    notionOAuth: oauthConfigured(),
    // Which providers is not secret, and helps a developer see what a
    // deployment can do. Keys themselves are never reported.
    providers: configuredProviders(),
  })
})

// --- Notion OAuth -----------------------------------------------------------
// The extension asks what to open, opens it, then posts back the ?code. The
// client secret is used only inside notion-oauth.js and never sent anywhere.

/** Everything the extension needs to BUILD the authorize URL - all public. */
app.get('/notion/oauth/config', (req, res) => {
  res.json({ configured: oauthConfigured(), clientId: clientId(), redirectUri: redirectUri() })
})

app.post('/notion/oauth/exchange', async (req, res) => {
  const { code, redirectUri: callerRedirectUri } = req.body || {}
  try {
    res.json(await exchangeCode(code, callerRedirectUri))
  } catch (error) {
    sendError(res, error, 'NOTION_OAUTH_FAILED')
  }
})

app.post('/notion/oauth/refresh', async (req, res) => {
  try {
    res.json(await refreshToken((req.body || {}).refreshToken))
  } catch (error) {
    sendError(res, error, 'NOTION_OAUTH_FAILED')
  }
})

// --- AI ---------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 180_000
const MAX_PROMPT_CHARS = 60_000

/**
 * Problems with THIS deployment (no key, bad key, no credit) are the
 * operator's to fix. The user sees one sentence they can act on - try later -
 * and the real reason goes to the server log where the operator will see it.
 */
const OPERATOR_ERRORS = new Set(['BACKEND_NO_KEY', 'AI_BAD_KEY', 'AI_FORBIDDEN', 'AI_QUOTA', 'AI_BAD_MODEL', 'AI_UNKNOWN_PROVIDER', 'AI_HTTP'])

app.post('/generate', async (req, res) => {
  const { providerId, system, user, schema } = req.body || {}

  if (typeof user !== 'string' || !user.trim() || !schema) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Both "user" and "schema" are required.' })
  }
  if ((system || '').length + user.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ code: 'BAD_REQUEST', message: 'That request is too large.' })
  }
  // This server generates study notes and nothing else. Only the extension's
  // own output shapes are accepted, so it cannot be used as a general proxy
  // for whoever finds the URL.
  if (!isKnownSchema(schema)) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Unknown output schema.' })
  }

  try {
    // Model and base URL are NOT taken from the request: the deployment
    // decides which provider, model and endpoint its key is spent on.
    const resolved = resolve(providerId || defaultProviderId())
    const adapter = getAdapter(resolved)
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    const data = await adapter.generateStructured({ system: system || '', user }, schema, resolved, signal)
    res.json({ data })
  } catch (error) {
    if (signalTimedOut(error, UPSTREAM_TIMEOUT_MS)) {
      return res.status(504).json({ code: 'AI_TIMEOUT', retryable: true, message: 'The AI service took too long to respond. Please try again.' })
    }
    if (error?.code === 'NETWORK') {
      console.error(`[generate] cannot reach provider: ${error.message}`)
      return res.status(503).json({ code: 'AI_SERVICE_ERROR', retryable: true, message: 'The AI service is temporarily unavailable. Please try again.' })
    }
    if (OPERATOR_ERRORS.has(error?.code)) {
      console.error(`[generate] ${error.code}: ${error.message}${error.detail ? ` — ${String(error.detail).slice(0, 300)}` : ''}`)
      return res.status(503).json({ code: 'AI_SERVICE_ERROR', retryable: false, message: 'The AI service is temporarily unavailable. Please try again later.' })
    }
    // AppError from a shared adapter carries a code, a human message and
    // whether it is worth retrying (rate limit, upstream 5xx, empty reply).
    const status = error.status || (error.retryable ? 503 : 400)
    res.status(status).json({ code: error.code || 'BACKEND_ERROR', retryable: Boolean(error.retryable), message: error.message })
  }
})

/** The adapters report an aborted fetch as a network failure; tell the two apart by the clock. */
const signalTimedOut = (error, budget) =>
  error?.name === 'TimeoutError' || error?.code === 'CANCELLED' || (error?.code === 'NETWORK' && error?.cause?.name === 'AbortError') || (error?.code === 'NETWORK' && budget <= 0)

/** OAuth errors: the message is for the user, `detail` (if any) for whoever runs the server. */
function sendError(res, error, fallbackCode) {
  if (error.detail) console.error(`[oauth] ${error.code || fallbackCode}: ${error.detail}`)
  res.status(error.status || 400).json({ code: error.code || fallbackCode, message: error.message, ...(error.detail && !isProduction ? { detail: error.detail } : {}) })
}

app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'No such endpoint.' }))

// Anything that escaped a handler - a JSON parse error, a bug - ends as JSON
// too, never as an HTML stack trace.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'The request body was not valid JSON.' })
  }
  console.error(`[unhandled] ${error?.stack || error}`)
  res.status(500).json({ code: 'BACKEND_ERROR', message: 'Something went wrong on the server. Please try again.' })
})

// --- start ------------------------------------------------------------------

// Exported so a test can start the real server and shut it down again.
export const server = app.listen(PORT, HOST, () => {
  const ready = configuredProviders()
  console.log(`Brototype AI Notes backend listening on ${HOST}:${PORT}${isProduction ? '' : ` (http://localhost:${PORT})`}`)
  console.log(ready.length
    ? `AI providers with keys: ${ready.join(', ')} — default: ${defaultProviderId()}`
    : '⚠️  No AI provider key found — set OPENROUTER_API_KEY (or another *_API_KEY)')
  console.log(oauthConfigured()
    ? `Notion OAuth ready — redirect URI ${redirectUri()}`
    : `⚠️  Notion OAuth is OFF — missing ${['NOTION_OAUTH_CLIENT_ID', 'NOTION_OAUTH_CLIENT_SECRET', 'NOTION_OAUTH_REDIRECT_URI'].filter((k) => !process.env[k]).join(', ')}`)
  if (allowedExtensionIds.length) console.log(`Serving extension id(s): ${allowedExtensionIds.join(', ')}`)
  else console.log('⚠️  ALLOWED_EXTENSION_IDS is not set — any extension may call this server (fine for development)')
})

// Render sends SIGTERM on deploy/restart: stop taking connections, let the
// in-flight generation finish, then exit. Without this the process is killed
// mid-request and a user sees a failed task for no reason.
function shutdown(signal) {
  console.log(`${signal} received — shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
