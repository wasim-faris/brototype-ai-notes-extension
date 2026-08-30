/**
 * The backend runs the SAME provider adapters as the extension.
 *
 * These files are plain ES modules that use nothing browser-specific (no chrome
 * APIs, no DOM), so Node can import them directly. That is deliberate: there is
 * exactly one implementation of "how to talk to OpenRouter", so "via backend"
 * and "direct" cannot drift apart.
 *
 * Every value here comes from this server's environment. Nothing in a request
 * can change which endpoint, model or key is used: a request may only choose
 * among the providers this deployment has a key for.
 */

import * as gemini from '../../extension/src/ai/gemini.js'
import * as openaiCompatible from '../../extension/src/ai/openai-compatible.js'
import * as claude from '../../extension/src/ai/claude.js'
import { PROVIDERS, getProviderMeta } from '../../extension/src/ai/registry.js'

const ADAPTERS = {
  gemini,
  'openai-compatible': openaiCompatible,
  claude,
}

/** OPENROUTER_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, CLAUDE_API_KEY, GROK_API_KEY, CUSTOM_API_KEY */
const envKeyName = (providerId) => `${providerId.toUpperCase()}_API_KEY`

export const configuredProviders = () =>
  Object.keys(PROVIDERS).filter((id) => Boolean(process.env[envKeyName(id)]))

export const hasKey = (providerId) => Boolean(process.env[envKeyName(providerId)])

/**
 * The provider used when the extension does not name one (which is the normal
 * case): DEFAULT_PROVIDER if set, otherwise the first one with a key.
 */
export function defaultProviderId() {
  const wanted = (process.env.DEFAULT_PROVIDER || '').trim()
  if (wanted && hasKey(wanted)) return wanted
  return configuredProviders()[0] || wanted || 'openrouter'
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * Build the same "resolved provider config" object the extension builds, but
 * entirely from the environment.
 */
export function resolve(providerId) {
  const meta = getProviderMeta(providerId)
  if (!meta) throw fail(400, 'AI_UNKNOWN_PROVIDER', `Unknown provider "${providerId}".`)

  const apiKey = process.env[envKeyName(providerId)] || ''
  if (!apiKey) {
    throw fail(503, 'BACKEND_NO_KEY', `This deployment has no ${envKeyName(providerId)}, so it cannot use ${meta.label}.`)
  }

  const upper = providerId.toUpperCase()
  return {
    id: providerId,
    label: meta.label,
    adapter: meta.adapter,
    capabilities: meta.capabilities,
    maxOutputTokens: meta.capabilities.maxOutputTokens,
    model: (process.env[`${upper}_MODEL`] || meta.defaultModel || '').trim(),
    baseUrl: (process.env[`${upper}_BASE_URL`] || meta.defaultBaseUrl || '').trim(),
    apiKey,
    meta,
  }
}

export function getAdapter(resolved) {
  const adapter = ADAPTERS[resolved.adapter]
  if (!adapter) throw fail(500, 'AI_UNKNOWN_PROVIDER', `No adapter installed for "${resolved.adapter}".`)
  return adapter
}
