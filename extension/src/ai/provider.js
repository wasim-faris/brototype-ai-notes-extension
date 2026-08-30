/**
 * The provider boundary. Nothing above this line knows which AI is in use.
 *
 * Two independent axes are resolved here, which is what makes every combination
 * work ("Grok direct", "Grok via backend", "Gemini via backend", ...):
 *
 *   mode           direct | backend        HOW the provider is reached
 *   activeProvider gemini | openai | ...   WHICH provider it is
 *
 * getProvider() returns a small facade with two methods. generator.js calls
 * those and has no idea what is behind them.
 */

import * as gemini from './gemini.js'
import * as openaiCompatible from './openai-compatible.js'
import * as claude from './claude.js'
import * as transport from './transport.js'
import { PROVIDERS, getProviderMeta, blankProviderConfig } from './registry.js'
import { cleanValue, cleanBaseUrl } from './clean.js'
import { AppError } from '../lib/errors.js'
import { acceptableOverride, DEFAULT_BACKEND_URL } from '../lib/env.js'

const ADAPTERS = {
  gemini,
  'openai-compatible': openaiCompatible,
  claude,
}

/**
 * Flatten the stored config plus the registry defaults into the single object
 * every adapter receives. Adapters never see the whole app config, and never
 * see another provider's key.
 */
export function resolveProviderConfig(config, providerId = null) {
  const id = providerId || config.ai?.activeProvider || 'gemini'
  const meta = getProviderMeta(id)
  if (!meta) throw new AppError('AI_UNKNOWN_PROVIDER', `Unknown AI provider "${id}". Pick one on the Options page.`)

  const saved = config.ai?.providers?.[id] || blankProviderConfig(id)

  return {
    id,
    label: meta.label,
    adapter: meta.adapter,
    capabilities: meta.capabilities,
    maxOutputTokens: meta.capabilities.maxOutputTokens,
    requestsPerMinute: meta.requestsPerMinute,
    // cleanValue, not trim: model names and URLs are pasted from documentation
    // pages and routinely carry zero-width characters that trim() leaves behind.
    model: cleanValue(saved.model) || cleanValue(meta.defaultModel),
    // An empty saved baseUrl means "follow the registry", so defaults can be
    // improved later without stale copies sitting in everybody's storage.
    baseUrl: cleanBaseUrl(saved.baseUrl) || cleanBaseUrl(meta.defaultBaseUrl),
    baseUrlExplicit: cleanBaseUrl(saved.baseUrl),
    apiKey: cleanValue(saved.apiKey),
    meta,
  }
}

/** Why this provider is not ready to run, or null when it is. */
export function validateProviderConfig(resolved) {
  const { meta, label } = resolved
  if (!resolved.model) return `No model is set for ${label}. Choose one on the AI tab.`
  if (!resolved.baseUrl) return `No API base URL is set for ${label}. Add it on the AI tab.`
  if (!resolved.apiKey && !meta.keyOptional) return `No API key is saved for ${label}. Add yours on the AI tab.`
  return null
}

/**
 * The facade generator.js uses.
 * In backend mode the adapter is swapped for the transport, and the resolved
 * provider config rides along so the server knows which provider to run.
 */
export function getProvider(config) {
  const mode = config.ai?.mode || 'direct'
  const resolved = resolveProviderConfig(config)

  if (mode === 'backend') {
    // An empty URL means the server this build was made for. The server, not
    // the extension, decides which model runs, so none is named here.
    const backendUrl = acceptableOverride(config.ai?.backendUrl) || DEFAULT_BACKEND_URL
    const withBackend = { ...resolved, backendUrl }
    return {
      mode,
      resolved: withBackend,
      describe: () => 'Shared AI service · via backend',
      generateStructured: (prompt, schema, signal) => transport.generateStructured(prompt, schema, withBackend, signal),
      testConnection: (signal) => transport.testConnection(withBackend, signal),
    }
  }

  const problem = validateProviderConfig(resolved)
  if (problem) throw new AppError('AI_NOT_CONFIGURED', problem)

  const adapter = ADAPTERS[resolved.adapter]
  if (!adapter) throw new AppError('AI_UNKNOWN_PROVIDER', `No adapter is installed for "${resolved.adapter}".`)

  return {
    mode,
    resolved,
    describe: () => `${resolved.label} · ${resolved.model}`,
    generateStructured: (prompt, schema, signal) => adapter.generateStructured(prompt, schema, resolved, signal),
    testConnection: (signal) => adapter.testConnection(resolved, signal),
  }
}

export { PROVIDERS }
