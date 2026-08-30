/**
 * pages.js - creating and filling the actual Notion page.
 *
 * Notion lets you send at most 100 blocks per request and at most two levels of
 * nesting in one request. Rather than fight that, we build the page in layers:
 *
 *   1. create the page with just its header
 *   2. per task, append ONE collapsed toggle heading (and keep its block id)
 *   3. per subtopic, append a toggle into that task's block
 *
 * A pleasant side effect: step 3 is exactly the granularity you wanted for the
 * progress display ("Creating useContext..."), and if the run dies halfway the
 * tasks already written are real, finished pages.
 */

import { notion, pageTitle } from './client.js'
import { buildPageHeader, buildTaskSections, buildMainTopicBlock } from './blocks.js'
import { AppError } from '../lib/errors.js'

const MAX_CHILDREN_PER_REQUEST = 90 // Notion's cap is 100; leave headroom

/** Append blocks to a parent, splitting into legal-sized requests. */
async function appendInChunks(token, parentId, blocks, signal) {
  const created = []
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN_PER_REQUEST) {
    const slice = blocks.slice(i, i + MAX_CHILDREN_PER_REQUEST)
    const result = await notion.appendChildren(token, parentId, slice, signal)
    created.push(...(result.results || []))
  }
  return created
}

/**
 * Append one block that may carry more children than a single request allows.
 * Oversized children are appended afterwards, into the block we just created.
 */
async function appendBlockSafely(token, parentId, blockToAppend, signal) {
  const type = blockToAppend.type
  const children = blockToAppend[type]?.children || []

  if (children.length <= MAX_CHILDREN_PER_REQUEST) {
    const [created] = await appendInChunks(token, parentId, [blockToAppend], signal)
    return created
  }

  const head = { ...blockToAppend, [type]: { ...blockToAppend[type], children: children.slice(0, MAX_CHILDREN_PER_REQUEST) } }
  const [created] = await appendInChunks(token, parentId, [head], signal)
  await appendInChunks(token, created.id, children.slice(MAX_CHILDREN_PER_REQUEST), signal)
  return created
}

/** All child pages directly under the parent page, with their titles. */
export async function listChildPages(token, parentId, signal) {
  const pages = []
  let cursor
  do {
    const result = await notion.listChildren(token, parentId, cursor, signal)
    for (const child of result.results || []) {
      if (child.type === 'child_page') pages.push({ id: child.id, title: child.child_page?.title || '' })
    }
    cursor = result.has_more ? result.next_cursor : null
  } while (cursor)
  return pages
}

export async function findExistingPage(token, parentId, title, signal) {
  const children = await listChildPages(token, parentId, signal)
  return children.find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase()) || null
}

/** "Mod 6 — React" -> "Mod 6 — React (v2)" -> "(v3)"... */
export function nextAvailableTitle(existingTitles, base) {
  const taken = new Set(existingTitles.map((t) => t.trim().toLowerCase()))
  if (!taken.has(base.trim().toLowerCase())) return base
  for (let v = 2; v < 100; v++) {
    const candidate = `${base} (v${v})`
    if (!taken.has(candidate.trim().toLowerCase())) return candidate
  }
  return `${base} (${Date.now()})`
}

/** Archive every block on a page. Used by the "update" duplicate strategy. */
export async function clearPage(token, pageId, signal, onProgress) {
  let cursor
  const ids = []
  do {
    const result = await notion.listChildren(token, pageId, cursor, signal)
    ids.push(...(result.results || []).map((b) => b.id))
    cursor = result.has_more ? result.next_cursor : null
  } while (cursor)

  for (const [i, id] of ids.entries()) {
    onProgress?.({ type: 'status', message: `Clearing old content (${i + 1}/${ids.length})` })
    await notion.archiveBlock(token, id, signal)
  }
  return ids.length
}

/**
 * Create the DESTINATION page — the container the weekly study pages then get
 * created inside. Not to be confused with createStudyPage below, which makes
 * one week's notes; this one is made once, and stays empty.
 *
 * With no parentPageId it is created at the top level of the workspace, as a
 * private page owned by whoever authorised the connection. Notion allows that
 * `parent` only for public (OAuth) connections — an internal integration has no
 * user to own the page, so it must be given a parent page instead.
 */
export async function createDestinationPage(token, title, { parentPageId } = {}, signal) {
  const page = await notion.createPage(token, {
    parent: parentPageId ? { page_id: parentPageId } : { type: 'workspace', workspace: true },
    icon: { type: 'emoji', emoji: '📚' },
    properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } },
  }, signal)

  if (!page?.id) throw new AppError('NOTION_INVALID', 'Notion did not return a page id when creating the page.')
  return page
}

export async function createStudyPage(token, parentId, title, unit, taskCount, signal) {
  const page = await notion.createPage(token, {
    parent: { page_id: parentId },
    icon: { type: 'emoji', emoji: '📚' },
    properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } },
    children: buildPageHeader(unit, { taskCount }),
  }, signal)

  if (!page?.id) throw new AppError('NOTION_INVALID', 'Notion did not return a page id when creating the study page.')
  return page
}

/**
 * Write one task's notes into the page.
 * Creates the collapsed task heading first, then fills it section by section so
 * progress is visible and a mid-task failure still leaves usable content.
 */
export async function writeTask(token, pageId, notes, { signal, onProgress } = {}) {
  const heading = `${notes.number}. ${notes.title}`
  onProgress?.({ type: 'status', message: `Creating "${heading}" in Notion` })

  // Main topic = a top-level toggle H1. Everything for this task is appended
  // INTO this block (taskBlock.id), never onto the page, so collapsing the
  // main topic hides all of its subtopics.
  const taskBlock = await appendBlockSafely(token, pageId, buildMainTopicBlock(notes), signal)

  const sections = buildTaskSections(notes)
  for (const section of sections) {
    onProgress?.({ type: 'status', message: `  ↳ ${section.label}` })
    for (const blockToAppend of section.blocks) {
      await appendBlockSafely(token, taskBlock.id, blockToAppend, signal)
    }
  }

  return taskBlock.id
}

/** Resolve which page to write into, honouring the duplicate strategy. */
export async function resolveTargetPage({ token, parentId, title, strategy, unit, taskCount, signal, onProgress }) {
  const existingPages = await listChildPages(token, parentId, signal)
  const existing = existingPages.find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase())

  if (!existing) {
    const page = await createStudyPage(token, parentId, title, unit, taskCount, signal)
    return { page, title, action: 'created' }
  }

  if (strategy === 'skip') {
    return { page: { id: existing.id, url: null }, title, action: 'skipped' }
  }

  if (strategy === 'update') {
    onProgress?.({ type: 'status', message: `"${title}" already exists — replacing its contents` })
    await clearPage(token, existing.id, signal, onProgress)
    await notion.appendChildren(token, existing.id, buildPageHeader(unit, { taskCount }), signal)
    return { page: { id: existing.id, url: null }, title, action: 'updated' }
  }

  // 'new' (and anything unexpected): never destroy existing notes.
  const freshTitle = nextAvailableTitle(existingPages.map((p) => p.title), title)
  const page = await createStudyPage(token, parentId, freshTitle, unit, taskCount, signal)
  return { page, title: freshTitle, action: 'created-copy' }
}

export { pageTitle }
