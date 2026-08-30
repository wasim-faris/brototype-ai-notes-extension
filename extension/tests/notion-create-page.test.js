import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Creating the destination page — the one thing that used to require leaving
 * the extension, making a page in Notion by hand and sharing it with the
 * connection.
 *
 * The request shape matters more than usual here: Notion accepts a
 * workspace-level parent ONLY for an OAuth connection, and rejects the whole
 * call if `parent` is wrong. So the parent is pinned by test.
 */

let requests = []
let respond = async () => ({ ok: true, status: 200, json: { id: 'new-page-id', url: 'https://notion.so/new-page-id' } })

globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers })
  const r = await respond()
  return { ok: r.ok, status: r.status, headers: { get: () => null }, json: async () => r.json }
}

const { createDestinationPage } = await import('../src/notion/pages.js')

test.beforeEach(() => {
  requests = []
  respond = async () => ({ ok: true, status: 200, json: { id: 'new-page-id', url: 'https://notion.so/new-page-id' } })
})

test('with no parent, the page is created at the top level of the workspace', async () => {
  const page = await createDestinationPage('ntn_token', '📚 Brototype Notes')

  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.ok(requests[0].url.endsWith('/v1/pages'))
  assert.deepEqual(requests[0].body.parent, { type: 'workspace', workspace: true },
    'Notion requires exactly this shape for a top-level page')
  assert.equal(requests[0].body.properties.title.title[0].text.content, '📚 Brototype Notes')
  assert.equal(requests[0].headers.Authorization, 'Bearer ntn_token')
  assert.equal(page.id, 'new-page-id')
})

test('with a parent page, it is created inside that page instead', async () => {
  await createDestinationPage('ntn_token', 'Notes', { parentPageId: 'parent-123' })
  assert.deepEqual(requests[0].body.parent, { page_id: 'parent-123' })
})

test('the destination page is created empty, so the note hierarchy is unchanged', async () => {
  await createDestinationPage('ntn_token', 'Notes')
  // Weekly study pages become children of this one and bring their own header;
  // putting content here would change what a generated page looks like.
  assert.ok(!('children' in requests[0].body), 'the container page must have no blocks of its own')
  assert.deepEqual(requests[0].body.icon, { type: 'emoji', emoji: '📚' })
})

test('a very long name is truncated rather than rejected by Notion', async () => {
  await createDestinationPage('ntn_token', 'x'.repeat(5000))
  assert.equal(requests[0].body.properties.title.title[0].text.content.length, 2000)
})

test('a refused creation tells the user to reconnect with the needed permissions', async () => {
  respond = async () => ({ ok: false, status: 403, json: { message: 'Insufficient permissions for this endpoint.' } })
  await assert.rejects(() => createDestinationPage('ntn_token', 'Notes'), (e) => {
    assert.equal(e.code, 'NOTION_FORBIDDEN')
    assert.ok(/read and add content/i.test(e.message) && /reconnect/i.test(e.message), `unhelpful message: ${e.message}`)
    assert.ok(!/endpoint|HTTP|403/.test(e.message), 'no API vocabulary for the user')
    assert.equal(e.detail, 'Insufficient permissions for this endpoint.', "Notion's own words go to the developer detail")
    return true
  })
})

test('a rejected request keeps Notion\'s objection for developers, not for the user', async () => {
  respond = async () => ({ ok: false, status: 400, json: { message: 'body failed validation: body.parent.workspace should be defined' } })
  await assert.rejects(() => createDestinationPage('ntn_token', 'Notes'), (e) => {
    assert.equal(e.code, 'NOTION_INVALID')
    assert.ok(!e.message.includes('body.parent.workspace'), 'raw Notion JSON is not a user message')
    assert.ok(/retry/i.test(e.message), 'the user is told what to do')
    assert.ok(e.detail.includes('body.parent.workspace'), "Notion's own words are kept in detail")
    return true
  })
})

test('an expired connection is reported as an auth problem, so the UI can offer reconnect', async () => {
  respond = async () => ({ ok: false, status: 401, json: { message: 'API token is invalid.' } })
  await assert.rejects(() => createDestinationPage('ntn_token', 'Notes'), (e) => e.code === 'NOTION_UNAUTHORIZED')
})

test('a reply with no page id is a failure, not a silent success', async () => {
  respond = async () => ({ ok: true, status: 200, json: {} })
  await assert.rejects(() => createDestinationPage('ntn_token', 'Notes'), (e) => e.code === 'NOTION_INVALID')
})
