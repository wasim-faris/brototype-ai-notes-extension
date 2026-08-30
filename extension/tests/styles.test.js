import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The stylesheet, checked for the class of bug that only a human hovering a
 * button would otherwise find: a rule that wins on specificity and paints a
 * primary button's text and background the same colour.
 */
const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** Every rule whose selector matches a bare <button> descendant, with its declarations. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body: body.trim() }))

test('no descendant rule overrides a primary button\'s background without also owning its text colour', () => {
  // A selector like ".x .y button" (two classes + element) beats "button.primary"
  // (one class + element). If it sets a background and leaves `color` alone, a
  // primary button inside .x .y is white text on that background.
  for (const { selector, body } of rules) {
    for (const part of selector.split(',').map((p) => p.trim())) {
      const endsOnButton = /\bbutton$/.test(part) || /\bbutton:not\(/.test(part)
      if (!endsOnButton) continue
      const classCount = (part.match(/\./g) || []).length
      const excludesPrimary = /:not\(\.primary\)/.test(part)
      if (classCount >= 2 && !excludesPrimary && /(^|;)\s*background(-color)?\s*:/.test(body)) {
        assert.ok(/(^|;)\s*color\s*:/.test(body),
          `"${part}" outranks button.primary and sets a background but not a colour - a primary button inside it becomes invisible until hovered`)
      }
    }
  }
})

test('callout action chips are scoped to secondary buttons, so "Open in Notion" and "Retry failed" stay blue', () => {
  const chip = rules.find((r) => r.selector.startsWith('.callout .actions button'))
  assert.ok(chip, 'the callout chip rule exists')
  assert.match(chip.selector, /:not\(\.primary\)/)
  assert.ok(!rules.some((r) => r.selector === '.callout .actions button'), 'the unscoped rule must not come back')
})

test('every button has a visible keyboard focus ring and does not rely on hover to be readable', () => {
  assert.ok(rules.some((r) => r.selector === 'button:focus-visible' && /outline\s*:\s*2px/.test(r.body)))
  // A base button is dark text on a white surface with a border; hover only tints it.
  const base = rules.find((r) => r.selector === 'button')
  assert.match(base.body, /color:\s*var\(--text\)/)
  assert.match(base.body, /background:\s*var\(--surface\)/)
  assert.match(base.body, /border:\s*1px solid/)
})
