/**
 * The output shapes this server will generate. They are the extension's own
 * schema objects, imported rather than copied, so the two cannot drift.
 *
 * Anything else is refused: a public URL with an AI key behind it would
 * otherwise be a free general-purpose LLM proxy for whoever finds it.
 */

import { TASK_SCHEMA, TOPIC_ONLY_SCHEMA, QUESTIONS_SCHEMA, PROBE_SCHEMA } from '../../extension/src/ai/schema.js'

const KNOWN = [TASK_SCHEMA, TOPIC_ONLY_SCHEMA, QUESTIONS_SCHEMA, PROBE_SCHEMA].map((s) => JSON.stringify(s))

/** True when `schema` is byte-for-byte one of the extension's schemas. */
export function isKnownSchema(schema) {
  if (!schema || typeof schema !== 'object') return false
  let text
  try { text = JSON.stringify(schema) } catch { return false }
  return KNOWN.includes(text)
}
