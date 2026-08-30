/**
 * Backend transport.
 *
 * NOT a provider - a way of REACHING one. The extension posts the prompt, the
 * schema and which provider to use; the backend runs the very same adapter
 * files from this folder and holds the API key in its own .env.
 *
 * That is the point: "Grok via backend" and "Grok direct" produce identical
 * results, because there is exactly one implementation of Grok.
 */

import { AppError } from '../lib/errors.js'
import { postJson, errorMessage } from './http.js'

const base = (config) => config.backendUrl.replace(/\/$/, '')

const UNAVAILABLE = 'The AI service is temporarily unavailable. Please try again.'

/** The user can do nothing about the server, so the message says that and stops; the URL goes in detail. */
function unreachable(config, error) {
  return new AppError('BACKEND_UNREACHABLE', UNAVAILABLE,
    { retryable: true, cause: error, detail: `No answer from ${config.backendUrl}` })
}

/**
 * What the backend sends. The prompt and the output shape only: the backend
 * decides the provider, model and endpoint its key is spent on. `providerId`
 * is a preference it honours only when it has a key for that provider.
 */
export const requestBody = (prompt, schema, config) => ({
  providerId: config.id,
  system: prompt.system,
  user: prompt.user,
  schema,
})

export async function generateStructured(prompt, schema, config, signal) {
  let result
  try {
    result = await postJson(`${base(config)}/generate`, { body: requestBody(prompt, schema, config), signal })
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error
    throw unreachable(config, error)
  }

  if (!result.ok) {
    const json = result.json || {}
    const serverSaysRetry = typeof json.retryable === 'boolean' ? json.retryable : (result.status === 429 || result.status >= 500)
    // A backend reply always carries a sentence written for the user; anything
    // else (a proxy error page, a crash) is the same outage from their side.
    const message = json.code && json.message ? json.message : UNAVAILABLE
    throw new AppError(json.code || 'BACKEND_ERROR', message,
      { retryable: serverSaysRetry, detail: json.detail || (json.message ? null : `${config.backendUrl} answered HTTP ${result.status}: ${errorMessage(json, result.text)}`) })
  }
  return result.json?.data
}

export async function testConnection(config, signal) {
  let response
  try {
    response = await fetch(`${base(config)}/health?providerId=${encodeURIComponent(config.id)}`, { signal })
  } catch (error) {
    throw unreachable(config, error)
  }

  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new AppError('BACKEND_ERROR', UNAVAILABLE, { retryable: true, detail: `${config.backendUrl}/health answered HTTP ${response.status}` })
  if (json.aiConfigured === false) {
    throw new AppError('BACKEND_NO_KEY', UNAVAILABLE, { detail: `${config.backendUrl} is running but has no AI provider key configured.` })
  }
  return { ok: true, reply: 'backend healthy' }
}
