/**
 * A small, throttled Notion REST client.
 *
 * Two things make this file necessary rather than just calling fetch():
 *
 * 1. RATE LIMITING. Notion allows roughly 3 requests per second per integration.
 *    A week of notes is a few hundred requests, so without a queue you would be
 *    throttled within seconds. Every request goes through one serial queue.
 *
 * 2. ERROR TRANSLATION. Notion's most common failure is a 404 that actually
 *    means "you forgot to share the page with your integration". Left raw, that
 *    is baffling. We translate it into the sentence that tells you what to do.
 *
 * Note on CORS: a normal web page cannot call api.notion.com. An extension
 * service worker with "https://api.notion.com/*" in host_permissions can, so
 * every call below runs straight from the worker. Only the OAuth token
 * exchange needs a server, because that one needs a client secret — see
 * notion/oauth.js.
 */

import { AppError } from '../lib/errors.js'

const API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const MIN_GAP_MS = 350 // ~3 requests/second

let queue = Promise.resolve()
let lastRequestAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Serialises every call and keeps them at least MIN_GAP_MS apart. */
function enqueue(work) {
  const result = queue.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return work()
  })
  queue = result.catch(() => {}) // a failure must not poison the queue
  return result
}

function mapError(status, body) {
  const detail = body?.message || ''

  if (status === 401) {
    return new AppError('NOTION_UNAUTHORIZED', 'Your Notion connection has expired. Reconnect Notion to continue.', { detail })
  }
  if (status === 403) {
    return new AppError('NOTION_FORBIDDEN', "Notion doesn't have permission to read and add content here. Please reconnect Notion and allow the required access.", { detail })
  }
  if (status === 404) {
    return new AppError('NOTION_NOT_SHARED', "Notion can't find that page, or this extension wasn't given access to it. Reconnect Notion and tick the page, or add this app from the page's ••• → Connections menu.", { detail })
  }
  if (status === 429) {
    return new AppError('NOTION_RATE_LIMIT', 'Notion rate limit hit. Slowing down and retrying automatically.', { retryable: true, detail })
  }
  if (status === 400) {
    return new AppError('NOTION_INVALID', "Notion couldn't save this content. Please retry the task.", { detail })
  }
  if (status >= 500) {
    return new AppError('NOTION_SERVER', 'Notion had a temporary server error. Retrying automatically.', { retryable: true, detail })
  }
  return new AppError('NOTION_HTTP', 'Notion returned an unexpected error. Please try again.', { detail: `HTTP ${status}. ${detail}` })
}

async function rawRequest(method, path, token, body, signal) {
  let response
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (error) {
    if (error.name === 'AbortError') throw new AppError('CANCELLED', 'Cancelled.')
    throw AppError.from(error)
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After') || 1)
    throw Object.assign(mapError(429, {}), { retryAfterMs: retryAfter * 1000 })
  }

  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw mapError(response.status, json)
  return json
}

/** Public entry point: queued, throttled, and retried on transient failures. */
export function notionRequest(method, path, { token, body, signal, attempts = 3 } = {}) {
  return enqueue(async () => {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await rawRequest(method, path, token, body, signal)
      } catch (error) {
        lastError = AppError.from(error)
        if (!lastError.retryable || attempt === attempts) throw lastError
        await sleep(error.retryAfterMs || attempt * 1500)
      }
    }
    throw lastError
  })
}

// --- Thin wrappers over the endpoints this project uses -------------------

export const notion = {
  /** Who am I? Used by the Options page to verify the token. */
  me: (token, signal) => notionRequest('GET', '/users/me', { token, signal }),

  /** Pages the integration has been given access to. */
  searchPages: (token, query = '', signal) =>
    notionRequest('POST', '/search', {
      token, signal,
      body: {
        query,
        filter: { value: 'page', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 50,
      },
    }),

  createPage: (token, body, signal) => notionRequest('POST', '/pages', { token, body, signal }),

  appendChildren: (token, blockId, children, signal) =>
    notionRequest('PATCH', `/blocks/${blockId}/children`, { token, body: { children }, signal }),

  listChildren: (token, blockId, cursor, signal) =>
    notionRequest('GET', `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, { token, signal }),

  archiveBlock: (token, blockId, signal) =>
    notionRequest('PATCH', `/blocks/${blockId}`, { token, body: { archived: true }, signal }),
}

/** Notion page titles live in different property shapes; this finds the text. */
export function pageTitle(page) {
  if (page?.object !== 'page') return ''
  const props = page.properties || {}
  const titleProp = Object.values(props).find((p) => p?.type === 'title')
  return (titleProp?.title || []).map((t) => t.plain_text).join('').trim()
}
