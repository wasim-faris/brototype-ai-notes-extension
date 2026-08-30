/**
 * Anthropic Claude adapter.
 *
 * Claude has no `response_format: json_schema`. Its equivalent - and it is just
 * as strict - is a FORCED TOOL CALL: we define one tool whose input_schema is
 * our schema, then set tool_choice so the model must call it. What comes back
 * in `tool_use.input` is schema-shaped structured data, never prose.
 */

import { AppError } from '../lib/errors.js'
import { postJson, errorMessage, mapCommonError } from './http.js'
import { PROBE_SCHEMA, PROBE_PROMPT } from './schema.js'

const TOOL_NAME = 'emit_study_notes'
const ANTHROPIC_VERSION = '2023-06-01'

const url = (config) => `${config.baseUrl.replace(/\/$/, '')}/messages`

async function call(body, config, signal) {
  const result = await postJson(url(config), {
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // The request originates from an extension, so its Origin header is a
      // chrome-extension:// URL. Anthropic blocks browser-origin calls unless
      // this opt-in header is present.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
    signal,
  })

  if (!result.ok) {
    const detail = errorMessage(result.json, result.text)
    if (result.status === 400 && /credit|balance/i.test(detail)) {
      throw new AppError('AI_QUOTA', `${config.label} says the account has no API credit. Note that a Claude.ai subscription does not include API access.`, { detail })
    }
    throw mapCommonError(result.status, detail, config.label)
  }
  return result.json || {}
}

export async function generateStructured({ system, user }, schema, config, signal) {
  const json = await call({
    model: config.model,
    max_tokens: config.maxOutputTokens,
    temperature: 0.4,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [{
      name: TOOL_NAME,
      description: 'Return the completed study notes as structured data.',
      input_schema: schema, // plain JSON Schema: exactly what Claude expects
    }],
    tool_choice: { type: 'tool', name: TOOL_NAME }, // forces structured output
  }, config, signal)

  if (json.stop_reason === 'max_tokens') {
    throw new AppError('AI_TRUNCATED', 'The response was too long and got cut off.')
  }

  const toolUse = (json.content || []).find((part) => part.type === 'tool_use' && part.name === TOOL_NAME)
  if (!toolUse) {
    const said = (json.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    throw new AppError('AI_INVALID_JSON', `${config.label} replied with text instead of structured notes. Retrying automatically.`, { retryable: true, detail: said.slice(0, 400) })
  }
  if (!toolUse.input || typeof toolUse.input !== 'object') {
    throw new AppError('AI_EMPTY', `${config.label} returned empty notes. Retrying automatically.`, { retryable: true })
  }

  return toolUse.input
}

/**
 * Runs the REAL generateStructured() path with a tiny schema, so passing the
 * test means generation will work: same endpoint, same forced tool call, same
 * headers, same extraction of tool_use.input.
 */
export async function testConnection(config, signal) {
  const probe = await generateStructured(PROBE_PROMPT, PROBE_SCHEMA, { ...config, maxOutputTokens: 256 }, signal)
  return { ok: true, reply: probe?.ok || 'ok', reportedModel: probe?.model || '' }
}
