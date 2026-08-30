/**
 * Shared HTTP plumbing for the provider adapters.
 *
 * Every provider fails in the same handful of ways (bad key, no access, rate
 * limit, server error), so the translation into a human sentence lives here
 * once. Adapters only add the parts that are genuinely specific to them.
 */

import { AppError } from '../lib/errors.js'

export async function postJson(url, { headers, body, signal }) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new AppError('CANCELLED', 'Generation was cancelled.')
    throw new AppError('NETWORK', `Could not reach ${safeHost(url)}. Check your connection, and that the base URL is correct.`, { retryable: true, cause: error })
  }

  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* leave json null; text is kept */ }

  return { ok: response.ok, status: response.status, json, text, headers: response.headers }
}

const safeHost = (url) => { try { return new URL(url).host } catch { return url } }

/** Pull the human-readable message out of whatever error envelope was used. */
export function errorMessage(json, text) {
  // OpenRouter wraps the upstream provider's real message in metadata.raw and
  // puts only "Provider returned error" in message. Prefer the real one.
  const upstream = json?.error?.metadata?.raw
  if (upstream && typeof upstream === 'string') return upstream
  return (
    json?.error?.message ||
    json?.error?.detail ||
    (typeof json?.error === 'string' ? json.error : '') ||
    json?.message ||
    json?.detail ||
    (text || '').slice(0, 300)
  )
}

/** The failures that mean the same thing everywhere. */
export function mapCommonError(status, detail, label) {
  if (status === 401) {
    return new AppError('AI_BAD_KEY', `${label} rejected your API key. Open Options and replace it.`, { detail })
  }
  if (status === 403) {
    // Providers explain 403s well ("your team has no credits yet"), so lead
    // with their words and keep the generic guess only as a fallback.
    return new AppError('AI_FORBIDDEN',
      detail
        ? `${label} refused the request. ${label} says: ${detail}`
        : `${label} refused this request. The key may lack access to this model, or the account may need billing enabled.`,
      { detail })
  }
  if (status === 404) {
    return new AppError('AI_BAD_MODEL', `${label} does not recognise that model or base URL. Check both on the Options page.`, { detail })
  }
  if (status === 429) {
    return new AppError('AI_RATE_LIMIT', `${label} rate limit hit. Waiting and retrying automatically.`, { retryable: true, detail })
  }
  if (status === 402 || /quota|insufficient|billing|credit/i.test(detail || '')) {
    return new AppError('AI_QUOTA', `${label} says the account is out of quota or credit. Check your billing, or switch provider in Options.`, { detail })
  }
  if (status >= 500) {
    return new AppError('AI_SERVER', `${label} had a temporary server error. Retrying automatically.`, { retryable: true, detail })
  }
  return new AppError('AI_HTTP', `${label} returned HTTP ${status}. ${detail || ''}`.trim(), { detail })
}
