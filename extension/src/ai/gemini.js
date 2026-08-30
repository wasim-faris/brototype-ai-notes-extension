/**
 * Google Gemini adapter.
 *
 * Endpoint shape (from Google's API reference):
 *   POST {baseUrl}/models/{model}:generateContent
 *   header: x-goog-api-key: <key>
 *
 * Structured output mechanism: `generationConfig.responseSchema`, which
 * constrains the model DURING decoding - it physically cannot return prose.
 * Gemini wants an OpenAPI-flavoured schema, so the neutral schema is passed
 * through toGeminiSchema() first.
 *
 * A note on the URL, because getting it subtly wrong is the single easiest way
 * to break this adapter: Google's docs write model names as "models/gemini-..."
 * in some places and "gemini-..." in others. Both must work, and the model id
 * must NOT be blindly percent-encoded, or a pasted "models/" prefix turns into
 * "%2F" and the request 404s with an empty body and no explanation.
 */

import { AppError } from '../lib/errors.js'
import { postJson, errorMessage, mapCommonError } from './http.js'
import { toGeminiSchema, PROBE_SCHEMA, PROBE_PROMPT } from './schema.js'
import { cleanValue, describeHidden, hasHiddenCharacters } from './clean.js'

/**
 * `thinkingConfig.thinkingBudget` is accepted ONLY by the 2.5 family.
 * Verified against the live API: sending it to a 2.0 or a 3.x model is a hard
 * 400 ("Request contains an invalid argument"). Gemini 3.x uses `thinkingLevel`
 * instead, and we simply leave its thinking on - the notes are better for it,
 * and the 65k output budget has room.
 */
const acceptsThinkingBudget = (model) => /(^|[^\d.])2\.5([^\d]|$)/.test(model)

// What Google actually allows in a model id.
const MODEL_ID = /^[A-Za-z0-9._-]+$/

/**
 * "models/gemini-2.5-flash-lite" and "gemini-2.5-flash-lite" both resolve to
 * the same path segment. Anything that is not a legal model id is rejected
 * here, with a message naming the value, instead of becoming a silent 404.
 */
export function modelPathSegment(rawModel) {
  const model = cleanValue(rawModel).replace(/^\/*models\//i, '')

  if (!model) {
    throw new AppError('AI_NOT_CONFIGURED',
      'No Gemini model is set. Open Options → AI provider and enter one, for example gemini-2.5-flash-lite.')
  }
  if (!MODEL_ID.test(model)) {
    // A DIFFERENT code from AI_BAD_MODEL on purpose. This failure happens
    // locally, before any request is sent, so it must never be confused with
    // "Google says that model does not exist" - see testConnection() below.
    const visible = describeHidden(model)
    throw new AppError('AI_INVALID_MODEL_NAME',
      `The model name is not usable: "${visible}". ` +
      (hasHiddenCharacters(model)
        ? 'It contains characters that are invisible or that only look like ordinary ones — for example an en-dash pasted in place of a hyphen. They are shown above as \\uXXXX. Retype the name by hand in Options → AI provider.'
        : 'A Gemini model id may only contain letters, numbers, dots, hyphens and underscores — for example gemini-2.5-flash.'),
      { detail: `raw value: "${describeHidden(rawModel)}"` })
  }
  return model
}

/**
 * Base URLs are pasted by hand too. Accept the version root with or without a
 * trailing "/models", so both of these work:
 *   https://generativelanguage.googleapis.com/v1beta
 *   https://generativelanguage.googleapis.com/v1beta/models
 */
export function buildEndpoint(rawBaseUrl, rawModel, method = 'generateContent') {
  const baseUrl = cleanValue(rawBaseUrl).replace(/\/+$/, '').replace(/\/models$/i, '')
  if (!baseUrl) {
    throw new AppError('AI_NOT_CONFIGURED', 'No Gemini API base URL is set. Open Options → AI provider.')
  }
  return `${baseUrl}/models/${modelPathSegment(rawModel)}:${method}`
}

/**
 * Flags an error as "this came back from the server", which distinguishes a real
 * HTTP failure from one raised locally before anything was sent. Also records
 * the exact URL requested, so no failure is ever un-diagnosable again.
 */
function markSent(error, url) {
  error.sentRequest = true
  error.requestUrl = url
  if (!error.detail) error.detail = `POST ${url}`
  return error
}

function mapError(status, json, text, config, url) {
  const detail = errorMessage(json, text)

  if (status === 400 && /api key not valid/i.test(detail)) {
    return new AppError('AI_BAD_KEY', `${config.label} rejected your API key. It should start with "AIza".`, { detail })
  }
  if (status === 404) {
    // Google's own 404 text is often the complete answer - for example
    // "This model is no longer available to new users. Please update your code
    // to use models/gemini-3.6-flash". It goes FIRST and verbatim. An earlier
    // version replaced it with a generated list of "available" models, which
    // both hid the fix and contradicted itself.
    const error = markSent(new AppError('AI_BAD_MODEL',
      detail
        ? `${config.label} refused the model "${config.model}". Google says: ${detail}`
        : `${config.label} returned 404 for model "${config.model}" on ${config.baseUrl}, with no explanation. The model name is probably wrong for this API version.`,
      { detail: `POST ${url}`, retryable: false }), url)
    // Lets testConnection know whether it needs to add anything at all.
    error.upstreamExplained = Boolean(detail)
    return error
  }
  if (status === 400) {
    return new AppError('AI_BAD_REQUEST', `${config.label} rejected the request: ${detail || 'bad request'}`, { detail })
  }
  return mapCommonError(status, detail, config.label)
}

async function call(body, config, signal, method = 'generateContent') {
  const url = buildEndpoint(config.baseUrl, config.model, method)
  const result = await postJson(url, {
    // Header rather than ?key= so the key never lands in a URL, log or referrer.
    headers: { 'x-goog-api-key': config.apiKey },
    body,
    signal,
  })
  if (!result.ok) throw markSent(mapError(result.status, result.json, result.text, config, url), url)
  return result.json || {}
}

export async function generateStructured({ system, user }, schema, config, signal) {
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: toGeminiSchema(schema),
    temperature: 0.4, // low: accurate notes, not creative ones
    maxOutputTokens: config.maxOutputTokens,
  }
  // Thinking tokens count towards the output budget and are not needed for
  // structured note writing, so turn them off to keep responses whole.
  if (acceptsThinkingBudget(config.model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }

  const json = await call({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  }, config, signal)

  if (json.promptFeedback?.blockReason) {
    throw new AppError('AI_BLOCKED', `${config.label} blocked this request (${json.promptFeedback.blockReason}). Try rewording the task title.`)
  }

  const candidate = json.candidates?.[0]
  if (!candidate) throw new AppError('AI_EMPTY', `${config.label} returned no content. Retrying automatically.`, { retryable: true })

  if (candidate.finishReason === 'MAX_TOKENS') {
    // generator.js catches this and retries one subtopic at a time.
    throw new AppError('AI_TRUNCATED', 'The response was too long and got cut off.')
  }
  if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
    throw new AppError('AI_BLOCKED', `${config.label} stopped for policy reasons (${candidate.finishReason}).`)
  }

  const text = candidate.content?.parts?.map((p) => p.text).join('') || ''
  if (!text.trim()) throw new AppError('AI_EMPTY', 'AI returned an empty response. Try again.', { retryable: true, detail: `${config.label} · ${config.model}` })

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new AppError('AI_INVALID_JSON', `${config.label} returned something that was not valid JSON. Retrying automatically.`, { retryable: true, cause: error, detail: text.slice(0, 400) })
  }
}

/**
 * Which models this key can actually reach. Used only to turn a model 404 into
 * a specific answer rather than a guess.
 */
export async function listModels(config, signal) {
  const baseUrl = cleanValue(config.baseUrl).replace(/\/+$/, '').replace(/\/models$/i, '')
  let response
  try {
    response = await fetch(`${baseUrl}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': config.apiKey },
      signal,
    })
  } catch {
    return null // diagnostics are best-effort; never mask the original error
  }
  if (!response.ok) return null

  const json = await response.json().catch(() => null)
  return (json?.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
}

/**
 * Test Connection runs the REAL generation path with a tiny schema, so a pass
 * here means note generation will work too - same URL construction, same system
 * prompt, same responseSchema mechanism, same JSON parsing.
 *
 * On a model 404 it additionally asks Google which models the key does have,
 * turning "not recognised" into an actionable list.
 */
export async function testConnection(config, signal) {
  try {
    // 2048, not a token or two: Gemini 3.x models think before answering, and
    // those tokens come out of this budget. A 256-token probe returns MAX_TOKENS
    // with empty content and looks like a failure when nothing is wrong.
    const probe = await generateStructured(PROBE_PROMPT, PROBE_SCHEMA, { ...config, maxOutputTokens: 2048 }, signal)
    return { ok: true, reply: probe?.ok || 'ok', reportedModel: probe?.model || '' }
  } catch (error) {
    // ONLY a genuine upstream 404 gets the "which models do I have?" treatment.
    //
    // This used to catch AI_BAD_MODEL, which modelPathSegment() also threw for a
    // locally-invalid name. The probe then reported "Google has no model X"
    // while listing X as available - because no request had ever been sent, and
    // the real explanation had been thrown away. Every other error, including
    // local validation, is now re-raised untouched.
    if (error?.code !== 'AI_BAD_MODEL' || !error?.sentRequest) throw error

    // If Google already explained itself, its answer is better than anything we
    // could synthesise - do not touch it.
    if (error.upstreamExplained) throw error

    const available = await listModels(config, signal)
    if (!available?.length) throw error

    // Deliberately hedged. ListModels reports models that generateContent then
    // refuses (retired models stay listed), so this is a hint, not a promise.
    const usable = available.filter((m) => m.startsWith('gemini-'))
    throw new AppError('AI_BAD_MODEL',
      `${config.label} returned 404 for the model "${config.model}" and gave no reason. Models the API lists for your key include: ${(usable.length ? usable : available).slice(0, 8).join(', ')} — note that some listed models are retired and will still be refused.`,
      { detail: `${error.detail || ''}\nall listed: ${available.join(', ')}`.trim() })
  }
}
