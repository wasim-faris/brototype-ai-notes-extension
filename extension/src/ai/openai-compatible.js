/**
 * Adapter for every service that speaks OpenAI's POST /chat/completions.
 *
 * That is OpenAI itself, xAI Grok, and the long tail of compatible services
 * (DeepSeek, Groq, OpenRouter, Together, LM Studio, Ollama). One adapter rather
 * than one file per vendor: they send the same request, so separate files would
 * be copies that drift. If a vendor ever genuinely diverges, it gets its own
 * adapter and one line changes in registry.js.
 *
 * Structured output: `response_format`. Support varies, so the adapter walks
 * down a ladder and remembers which rung worked for this base URL:
 *
 *   json_schema (strict)  →  json_object  →  schema described in the prompt
 */

import { AppError } from '../lib/errors.js'
import { postJson, errorMessage, mapCommonError } from './http.js'
import { toStrictJsonSchema, schemaToPromptText, PROBE_SCHEMA, PROBE_PROMPT } from './schema.js'
import { extractJson } from './json.js'

const LADDER = ['json_schema', 'json_object', 'prompt']

// Remembered per base URL for this service-worker lifetime, so a server that
// rejects json_schema is only probed once instead of on every task.
const known = new Map()

const url = (config) => `${config.baseUrl.replace(/\/$/, '')}/chat/completions`

/** True when the server is telling us it does not understand response_format. */
function isUnsupportedFormat(status, detail) {
  if (status !== 400 && status !== 404 && status !== 422) return false
  return /response_format|json_schema|json_object|not supported|unsupported|unrecognized|invalid.*schema/i.test(detail || '')
}

function buildBody(prompt, schema, config, mode) {
  const messages = []
  const systemText = mode === 'prompt' ? `${prompt.system}\n\n${schemaToPromptText(schema)}` : prompt.system

  if (config.capabilities.systemPrompt) messages.push({ role: 'system', content: systemText })
  else messages.push({ role: 'user', content: systemText })
  messages.push({ role: 'user', content: prompt.user })

  const body = {
    model: config.model,
    messages,
    temperature: 0.4,
    max_tokens: config.maxOutputTokens,
  }

  if (mode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'study_notes', strict: true, schema: toStrictJsonSchema(schema) },
    }
  } else if (mode === 'json_object') {
    body.response_format = { type: 'json_object' }
  }

  return body
}

/**
 * An error the service reported with HTTP 200.
 *
 * OpenRouter does this in two documented cases: a request blocked before it
 * reached a model (moderation, no endpoint for the model, upstream rate limit),
 * and a provider that died mid-generation, which arrives as `choices[0].error`.
 * Both used to read as "the model said nothing", so a rate limit and a missing
 * model were reported to the user as an empty response and retried pointlessly.
 */
function bodyError(json, choice, config) {
  const raw = json?.error || choice?.error
  if (!raw) return null
  const detail = raw.message || raw.metadata?.raw || 'The provider reported an error.'
  // `code` is an HTTP status here, so the normal mapping applies and a 429
  // stays retryable while a 404 does not.
  return mapCommonError(Number(raw.code) || 502, detail, config.label)
}

/**
 * The generated text, wherever this provider put it.
 *
 * `content` is the norm, but some services return it as an array of typed
 * parts, and a reasoning model can leave it empty and put everything under
 * `reasoning` / `reasoning_details` — reasoning tokens come out of the same
 * budget, so this is common on long structured answers.
 */
function readContent(message) {
  const content = message?.content
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const joined = content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim()
    if (joined) return joined
  }

  const reasoning = message?.reasoning
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning
  if (Array.isArray(message?.reasoning_details)) {
    const joined = message.reasoning_details.map((d) => d?.text || d?.content || '').join('').trim()
    if (joined) return joined
  }
  return ''
}

async function call(body, config, signal) {
  const headers = {}
  // Local servers such as Ollama accept no key at all.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  const result = await postJson(url(config), { headers, body, signal })
  if (!result.ok) {
    const detail = errorMessage(result.json, result.text)
    const error = mapCommonError(result.status, detail, config.label)
    error.unsupportedFormat = isUnsupportedFormat(result.status, detail)
    throw error
  }
  return result.json || {}
}

/** Which rung of the ladder to try first for this provider. */
function startingMode(config) {
  const declared = config.capabilities.structuredOutput
  if (declared !== 'auto') return declared
  return known.get(config.baseUrl) || 'json_schema'
}

export async function generateStructured(prompt, schema, config, signal) {
  const declared = config.capabilities.structuredOutput
  const start = LADDER.indexOf(startingMode(config))
  // A provider that declares a mechanism uses only that one; 'auto' walks down.
  const modes = declared === 'auto' ? LADDER.slice(Math.max(start, 0)) : [startingMode(config)]

  let lastError
  for (const mode of modes) {
    try {
      const json = await call(buildBody(prompt, schema, config, mode), config, signal)
      const choice = json.choices?.[0]

      // Before anything else: a failure the service chose to report with a 200.
      const reported = bodyError(json, choice, config)
      if (reported) throw reported

      if (choice?.finish_reason === 'length') {
        throw new AppError('AI_TRUNCATED', 'The response was too long and got cut off.')
      }
      if (choice?.finish_reason === 'content_filter') {
        throw new AppError('AI_BLOCKED', `${config.label} blocked this response. Try rewording the task title.`)
      }

      const text = readContent(choice?.message)
      if (!text) {
        // Nothing wrong with the request and nothing in the reply: OpenRouter
        // documents this for a model warming up from a cold start.
        throw new AppError('AI_EMPTY', 'AI returned an empty response. Try again.',
          { retryable: true, detail: `${config.label} · ${config.model} · finish_reason=${choice?.finish_reason ?? 'none'}` })
      }

      if (declared === 'auto') known.set(config.baseUrl, mode)
      return extractJson(text)
    } catch (error) {
      lastError = error
      // Only step down the ladder when the server rejected the MECHANISM.
      // A rate limit or bad key must surface as itself, not be retried weaker.
      if (!error?.unsupportedFormat || declared !== 'auto') throw error
    }
  }
  throw lastError
}

/**
 * Runs the REAL generateStructured() path with a tiny schema, so passing the
 * test means generation will work: same endpoint, same response_format, same
 * ladder probing for a custom server, same JSON parsing.
 */
export async function testConnection(config, signal) {
  const probe = await generateStructured(PROBE_PROMPT, PROBE_SCHEMA, { ...config, maxOutputTokens: 256 }, signal)
  return { ok: true, reply: probe?.ok || 'ok', reportedModel: probe?.model || '' }
}
