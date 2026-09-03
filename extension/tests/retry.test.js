import test from 'node:test'
import assert from 'node:assert/strict'
import { retryTransient, DIRECT_RETRY_DELAYS, BACKEND_RETRY_DELAYS } from '../src/ai/retry.js'
import { AppError } from '../src/lib/errors.js'

/**
 * "Test connection" once made a single request. A provider that answers its
 * first cold request with a 5xx then showed "temporary server error. Retrying
 * automatically." - and did not retry. These pin the policy it now shares
 * with note generation.
 */

const transient = () => new AppError('AI_SERVER', 'OpenRouter had a temporary server error. Retrying automatically.', { retryable: true })
const permanent = () => new AppError('AI_BAD_KEY', 'OpenRouter rejected your API key.', { retryable: false })

test('a transient failure on the first attempt is retried and the second success is returned - one click, not two', async () => {
  let calls = 0
  const retries = []
  const result = await retryTransient(async () => {
    calls++
    if (calls === 1) throw transient()
    return { ok: true, reply: 'ok' }
  }, { delays: [5, 5], onRetry: (r) => retries.push(r) })

  assert.deepEqual(result, { ok: true, reply: 'ok' })
  assert.equal(calls, 2)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].attempt, 1)
  assert.equal(retries[0].of, 3)
})

test('a first attempt that succeeds is returned as-is, with no waiting', async () => {
  const started = Date.now()
  const result = await retryTransient(async () => 'first', { delays: [500, 500] })
  assert.equal(result, 'first')
  assert.ok(Date.now() - started < 100, 'no delay before or after a successful call')
})

test('a permanent error is reported immediately - bad keys are never retried or hidden', async () => {
  let calls = 0
  await assert.rejects(() => retryTransient(async () => { calls++; throw permanent() }, { delays: [5, 5] }),
    (e) => e.code === 'AI_BAD_KEY')
  assert.equal(calls, 1)
})

test('when every attempt fails the last real error is shown, after all retries were actually made', async () => {
  let calls = 0
  await assert.rejects(() => retryTransient(async () => { calls++; throw transient() }, { delays: [5, 5, 5] }),
    (e) => e.code === 'AI_SERVER' && e.retryable)
  assert.equal(calls, 4, 'initial attempt + one per delay')
})

test('a plain Error (not an AppError) is normalised and, if it looks like a network failure, retried', async () => {
  let calls = 0
  const result = await retryTransient(async () => {
    calls++
    if (calls === 1) throw new TypeError('Failed to fetch')
    return 'ok'
  }, { delays: [5] })
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
})

test('cancelling during a wait stops the retries', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = retryTransient(async () => { calls++; throw transient() }, { delays: [10_000], signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(() => pending, (e) => e.code === 'CANCELLED')
  assert.equal(calls, 1)
})

test('the backend budget covers a Render cold start; the direct budget stays short', () => {
  const total = (d) => d.reduce((a, b) => a + b, 0)
  assert.ok(total(BACKEND_RETRY_DELAYS) >= 25_000, 'a sleeping free-tier service needs ~30s')
  assert.ok(total(DIRECT_RETRY_DELAYS) <= 10_000, 'a live provider should not keep the user waiting long')
})
