/**
 * registry.js - the list of AI providers the extension knows about.
 *
 * This is the ONLY file you edit to add a provider. It carries no network code:
 * each entry just says which adapter to use, what the sensible defaults are, and
 * what the provider is actually capable of.
 *
 * `structuredOutput` is the important capability. Providers force valid JSON in
 * genuinely different ways, and pretending otherwise is how you end up parsing
 * chat prose:
 *
 *   'response_schema' - Gemini: generationConfig.responseSchema
 *   'json_schema'     - OpenAI / Grok: response_format json_schema, strict
 *   'tool'            - Claude: a forced tool call whose input_schema is our schema
 *   'json_object'     - "reply in JSON" with no schema enforcement
 *   'prompt'          - nothing at all; the schema goes in the prompt text
 *   'auto'            - unknown server: try the list above, top down, remember
 *                       what worked
 *
 * Whatever the mechanism, the result goes through normaliseTask() before it can
 * reach Notion, so a weaker provider means more retries, never worse data.
 */

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    adapter: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Verified against the live API on 2026-08-29: the whole gemini-2.5-*
    // family now returns 404 "no longer available to new users" for keys
    // created recently, even though ListModels still reports it. Google's own
    // 404 text points at gemini-3.6-flash.
    defaultModel: 'gemini-3.6-flash',
    modelSuggestions: [
      'gemini-3.6-flash',        // Google's current recommendation
      'gemini-flash-latest',     // moving alias - survives the next rename
      'gemini-3.5-flash',
      'gemini-flash-lite-latest', // cheapest, largest free allowance
      'gemini-pro-latest',
    ],
    keyHint: 'AIza… or AQ.…',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    note: 'Has a free tier with no card required — the easiest place to start. Model names here are retired fairly often; if one stops working the error will quote Google\'s replacement.',
    capabilities: { structuredOutput: 'response_schema', systemPrompt: true, maxOutputTokens: 65536 },
    requestsPerMinute: 10,
  },

  openai: {
    label: 'OpenAI',
    adapter: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    modelSuggestions: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Needs a paid API account. A ChatGPT Plus/Go subscription does NOT include API access.',
    capabilities: { structuredOutput: 'json_schema', systemPrompt: true, maxOutputTokens: 32768 },
    requestsPerMinute: 60,
  },

  claude: {
    label: 'Anthropic Claude',
    adapter: 'claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    modelSuggestions: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Needs a paid API account. A Claude.ai subscription does NOT include API access.',
    // Claude has no "response_format: json_schema". Its reliable structured path
    // is a forced tool call, which is exactly as strict.
    capabilities: { structuredOutput: 'tool', systemPrompt: true, maxOutputTokens: 32000 },
    requestsPerMinute: 50,
  },

  grok: {
    label: 'xAI Grok',
    adapter: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-fast',
    modelSuggestions: ['grok-4-fast', 'grok-4', 'grok-3-mini', 'grok-3'],
    keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai',
    note: 'No free tier: a new xAI team must buy credits at console.x.ai before any request works, even with a valid key.',
    capabilities: { structuredOutput: 'json_schema', systemPrompt: true, maxOutputTokens: 32768 },
    requestsPerMinute: 60,
  },

  openrouter: {
    label: 'OpenRouter',
    adapter: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    // Verified end-to-end on 2026-08-29 with a free-tier key: a full task
    // (topics + 5 questions) came back schema-valid in ~45s. Other ":free"
    // models were rate-limited or truncated on the same run.
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    modelSuggestions: [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'z-ai/glm-5.2:free',
      'minimax/minimax-m2.7:free',
    ],
    keyHint: 'sk-or-v1-…',
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: 'One key, hundreds of models. Models ending in ":free" cost nothing but are rate-limited and shared, so a big run may need retries. Any model id from openrouter.ai/models works here.',
    // A router: structured-output support depends on the model behind it, so
    // probe json_schema → json_object → prompt and remember what worked.
    capabilities: { structuredOutput: 'auto', systemPrompt: true, maxOutputTokens: 16384 },
    // Free tier is roughly 20 requests/minute across all free models; stay well under.
    requestsPerMinute: 8,
  },

  custom: {
    label: 'Custom / OpenAI-compatible',
    adapter: 'openai-compatible',
    defaultBaseUrl: '',
    defaultModel: '',
    modelSuggestions: [],
    keyHint: 'optional for local servers',
    baseUrlRequired: true,
    keyOptional: true,
    note: 'Any service speaking POST /chat/completions — DeepSeek, Groq, Together, LM Studio, or a local Ollama server (port 11434, path /v1). OpenRouter has its own entry above.',
    // We do not know what this server supports, so the adapter probes downwards.
    capabilities: { structuredOutput: 'auto', systemPrompt: true, maxOutputTokens: 16384 },
    requestsPerMinute: 30,
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS)

export const getProviderMeta = (id) => PROVIDERS[id] || null

export const providerOptions = () =>
  PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label }))

/** Blank per-provider settings, used when a provider is configured for the first time. */
export const blankProviderConfig = (id) => ({
  apiKey: '',
  model: PROVIDERS[id]?.defaultModel || '',
  baseUrl: '', // empty means "use the registry default", so defaults can improve later
})
