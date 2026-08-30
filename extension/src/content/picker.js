/**
 * picker.js - the "point at the task list yourself" escape hatch.
 *
 * This is the safety net for the day Brototype changes their HTML so much that
 * automatic detection fails. You click the box containing the tasks, we work out
 * a selector for it, and we remember it. Next week detection just works again.
 *
 * The selector is built from STRUCTURE (tag + position), never from class names,
 * because Brototype's styled-components class names change on every deploy.
 */

const HIGHLIGHT_ID = 'bro-ai-notes-highlight'
const BANNER_ID = 'bro-ai-notes-banner'

/** A structural CSS path, e.g. "#root > div:nth-of-type(1) > div:nth-of-type(2)" */
export function cssPath(el) {
  const parts = []
  for (let node = el; node && node.nodeType === 1 && node !== document.body; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`#${node.id}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    const siblings = [...(node.parentElement?.children || [])].filter((c) => c.tagName === node.tagName)
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
  }
  return parts.join(' > ')
}

function ensureOverlay() {
  let box = document.getElementById(HIGHLIGHT_ID)
  if (box) return box
  box = document.createElement('div')
  box.id = HIGHLIGHT_ID
  Object.assign(box.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
    border: '2px solid #6366f1', background: 'rgba(99,102,241,0.12)',
    borderRadius: '6px', transition: 'all 60ms ease-out',
  })
  document.body.appendChild(box)
  return box
}

function showBanner(text) {
  let banner = document.getElementById(BANNER_ID)
  if (!banner) {
    banner = document.createElement('div')
    banner.id = BANNER_ID
    Object.assign(banner.style, {
      position: 'fixed', zIndex: '2147483647', top: '16px', left: '50%',
      transform: 'translateX(-50%)', background: '#111827', color: '#fff',
      padding: '10px 18px', borderRadius: '999px', fontSize: '14px',
      fontFamily: 'system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.3)',
      pointerEvents: 'none', maxWidth: '90vw', textAlign: 'center',
    })
    document.body.appendChild(banner)
  }
  banner.textContent = text
  return banner
}

const cleanup = () => {
  document.getElementById(HIGHLIGHT_ID)?.remove()
  document.getElementById(BANNER_ID)?.remove()
}

/**
 * Starts picking mode. Resolves with { selector } once you click something,
 * or { cancelled: true } if you press Escape.
 */
export function startPicker() {
  return new Promise((resolve) => {
    const box = ensureOverlay()
    showBanner('Click the box that contains your task list.  ·  Esc to cancel')
    let current = null

    const onMove = (event) => {
      const el = event.target
      if (!el || el.id === HIGHLIGHT_ID || el.id === BANNER_ID) return
      current = el
      const r = el.getBoundingClientRect()
      Object.assign(box.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` })
    }

    const finish = (result) => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      cleanup()
      resolve(result)
    }

    const onClick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!current) return finish({ cancelled: true })
      finish({ selector: cssPath(current) })
    }

    const onKey = (event) => {
      if (event.key === 'Escape') finish({ cancelled: true })
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
  })
}

export { showBanner, cleanup }
