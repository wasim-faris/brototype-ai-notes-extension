/**
 * All persistent configuration lives here, in chrome.storage.local.
 *
 * Why local and not sync: chrome.storage.sync copies data to Google's servers so
 * it can follow you between devices. API keys should not travel. Local storage
 * stays in this Chrome profile on this machine, and web pages (including
 * Brototype) cannot read it - only this extension can.
 *
 * The AI section keeps a SEPARATE configuration per provider, so switching from
 * Gemini to Grok and back never destroys either key.
 */

import { PROVIDER_IDS, blankProviderConfig, getProviderMeta } from '../ai/registry.js'
import { acceptableOverride, DEFAULT_BACKEND_URL } from './env.js'
import { DEFAULT_STUDY_STYLE_SETTINGS } from '../ai/studyStyle.js'

const CONFIG_KEY = 'config'

const blankProviders = () =>
  Object.fromEntries(PROVIDER_IDS.map((id) => [id, blankProviderConfig(id)]))

export const DEFAULT_CONFIG = {
  // Notion. Two ways in, in priority order:
  //   notionAuth  - the OAuth result ("Continue with Notion"), the normal path
  //   notionToken - an internal integration secret pasted by hand, which is
  //                 what this extension used before OAuth existed. Still read,
  //                 so an existing setup keeps working untouched.
  notionAuth: null,              // { accessToken, refreshToken, workspaceName, ... }
  notionToken: '',
  notionParentId: '',
  notionParentTitle: '',

  // An OPTIONAL override for the sign-in server. Empty means "the one this
  // build was made for" (lib/env.js), which is what a normal user always wants:
  // a release build then talks to the deployed server without anybody typing a
  // URL. Independent of ai.backendUrl on purpose — signing in to Notion must
  // work while the AI provider is being called directly.
  notionOAuthBackendUrl: '',

  // AI - two independent axes: how it is reached, and which provider it is.
  //
  // Every user brings their own key: 'direct' means this extension calls the
  // chosen provider itself, with a key that lives only in this Chrome profile
  // and is sent only to that provider. The backend is not involved in AI at
  // all. ('backend' - an operator-run proxy - is a development option only.)
  ai: {
    mode: 'direct',              // 'direct' | 'backend'
    // Just the initial dropdown selection: OpenRouter has free models and one
    // key reaches many providers, so it is the softest landing.
    activeProvider: 'openrouter',
    // Development only. Empty means "the backend this build was made for".
    backendUrl: '',
    providers: blankProviders(),
  },

  // How the AI explains things. Kept apart from `ai` on purpose: this is
  // student preference, that is credentials. See ai/studyStyle.js.
  studyStyle: { ...DEFAULT_STUDY_STYLE_SETTINGS },

  // Behaviour
  taskListSelector: '',          // remembered from the manual picker
  duplicateStrategy: 'ask',      // 'ask' | 'update' | 'new' | 'skip'
  aiRequestsPerMinute: null,     // null = use the active provider's own default
}

/**
 * Bring an older stored config up to date without losing anything.
 * Version 1 stored a single flat Gemini key; it is moved into the per-provider
 * structure rather than discarded.
 */
export function migrateConfig(stored) {
  if (!stored || typeof stored !== 'object') return null

  // Earlier releases stored the development server as a literal default. Now
  // an empty value means "this build's own server", and a release build never
  // accepts a plain-http override, so a stale localhost cannot pin a published
  // extension to a machine that is not running it.
  const stale = (url) => url && (acceptableOverride(url) !== url || url === DEFAULT_BACKEND_URL)
  if (stale(stored.notionOAuthBackendUrl)) stored = { ...stored, notionOAuthBackendUrl: '' }
  if (stale(stored.ai?.backendUrl)) stored = { ...stored, ai: { ...stored.ai, backendUrl: '' } }

  if (stored.ai && stored.ai.providers) return stored // already current

  const migrated = { ...stored }
  const providers = blankProviders()

  if (stored.geminiApiKey || stored.geminiModel) {
    providers.gemini = {
      apiKey: stored.geminiApiKey || '',
      model: stored.geminiModel || providers.gemini.model,
      baseUrl: '',
    }
  }

  migrated.ai = {
    // The old config used aiProvider to mean BOTH provider and transport.
    mode: stored.aiProvider === 'backend' ? 'backend' : 'direct',
    activeProvider: 'gemini',
    backendUrl: acceptableOverride(stored.backendUrl),
    providers,
  }

  delete migrated.geminiApiKey
  delete migrated.geminiModel
  delete migrated.aiProvider
  delete migrated.backendUrl
  return migrated
}

/** Merge that keeps nested objects intact instead of replacing them wholesale. */
function mergeConfig(base, patch) {
  const next = { ...base, ...patch }
  if (patch.studyStyle) {
    // So that saving { mode: 'default' } never wipes a custom prompt the
    // student spent time writing.
    next.studyStyle = { ...base.studyStyle, ...patch.studyStyle }
  }
  if (patch.ai) {
    next.ai = {
      ...base.ai,
      ...patch.ai,
      providers: {
        ...base.ai.providers,
        ...(patch.ai.providers || {}),
      },
    }
  }
  return next
}

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY)
  const migrated = migrateConfig(stored[CONFIG_KEY]) || {}
  const config = mergeConfig(DEFAULT_CONFIG, migrated)

  // A provider added to the registry after this config was saved still needs
  // an entry, or the Options page has nothing to bind its inputs to.
  config.ai.providers = { ...blankProviders(), ...config.ai.providers }
  return config
}

export async function setConfig(patch) {
  const next = mergeConfig(await getConfig(), patch)
  await chrome.storage.local.set({ [CONFIG_KEY]: next })
  return next
}

/** Change one provider's settings without touching any other provider's. */
export async function setProviderConfig(providerId, patch) {
  const config = await getConfig()
  const current = config.ai.providers[providerId] || blankProviderConfig(providerId)
  return setConfig({ ai: { providers: { [providerId]: { ...current, ...patch } } } })
}

/** What the popup needs to know before it lets you press Generate. */
export function configStatus(config) {
  const { mode, activeProvider, providers } = config.ai
  const provider = providers[activeProvider] || {}

  return {
    notionConnected: Boolean(resolveNotionToken(config)),
    notionParentChosen: Boolean(config.notionParentId),
    // In backend mode the key lives on the server and the server is known at
    // build time, so there is nothing a user has to configure.
    aiConfigured: mode === 'backend'
      ? true
      : Boolean(provider.apiKey || getProviderMeta(activeProvider)?.keyOptional),
  }
}

/**
 * The bearer token every Notion call uses. OAuth wins when both exist, so a
 * user who connects with OAuth stops depending on their old pasted secret
 * without it being deleted behind their back.
 */
export const resolveNotionToken = (config) =>
  config?.notionAuth?.accessToken || config?.notionToken || ''

/** 'oauth' | 'token' | 'none' - what the UI is looking at. */
export const notionAuthMethod = (config) =>
  config?.notionAuth?.accessToken ? 'oauth' : config?.notionToken ? 'token' : 'none'

/** Never render a secret in full. */
export const maskSecret = (value) =>
  !value ? '' : value.length <= 8 ? '••••••••' : `${'•'.repeat(12)}${value.slice(-4)}`
