/**
 * Reading JSON out of a response that was not guaranteed to be JSON.
 *
 * Providers with strict schema support never need this. It exists for the
 * weaker mechanisms ('json_object' and 'prompt'), where a model may still wrap
 * its answer in ```json fences or add a sentence of preamble.
 *
 * This is deliberately NOT a repair library: it locates the JSON and parses it,
 * or fails. Anything it returns still goes through normaliseTask().
 */

import { AppError } from '../lib/errors.js'

export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new AppError('AI_EMPTY', 'The AI returned an empty response.', { retryable: true })

  const candidates = []

  // 1. the whole thing, if it is already clean JSON
  candidates.push(raw)

  // 2. inside a ```json ... ``` fence
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())

  // 3. from the first { or [ to its matching close
  const start = raw.search(/[{[]/)
  if (start !== -1) {
    const open = raw[start]
    const close = open === '{' ? '}' : ']'
    const end = raw.lastIndexOf(close)
    if (end > start) candidates.push(raw.slice(start, end + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* try the next candidate */ }
  }

  throw new AppError('AI_INVALID_JSON', 'The AI did not return valid JSON. Retrying automatically.', {
    retryable: true,
    detail: raw.slice(0, 400),
  })
}
