/**
 * retry.js - one attempt is not a verdict.
 *
 * A provider's first answer after a cold start is often a transient failure
 * (OpenRouter free models 5xx while they spin up; a sleeping Render service
 * takes ~30s to wake). Note generation already retries those through
 * generator.js's callWithRetry; this is the same policy for single calls such
 * as "Test connection", which used to make exactly one request and report a
 * message that promised a retry that never happened.
 *
 * Only errors marked `retryable` are retried. A bad key, a wrong model or a
 * refused request is reported at once, exactly as before.
 */

import { AppError } from '../lib/errors.js'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new AppError('CANCELLED', 'Cancelled.')) }, { once: true })
})

/** Waits between attempts: a warm provider recovers in seconds, a cold backend in tens of seconds. */
export const DIRECT_RETRY_DELAYS = [1500, 4000]
export const BACKEND_RETRY_DELAYS = [3000, 8000, 15000]

/**
 * Run `fn` and, on a retryable failure, wait and run it again - once per entry
 * in `delays`. Resolves with the first success; rejects with the last error.
 */
export async function retryTransient(fn, { delays = DIRECT_RETRY_DELAYS, signal, onRetry } = {}) {
  let lastError
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn(attempt + 1)
    } catch (error) {
      lastError = AppError.from(error)
      if (!lastError.retryable || attempt === delays.length) throw lastError
      onRetry?.({ attempt: attempt + 1, of: delays.length + 1, delayMs: delays[attempt], error: lastError })
      await sleep(delays[attempt], signal)
    }
  }
  throw lastError
}
