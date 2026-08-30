/**
 * Cleaning values that arrive by copy-and-paste.
 *
 * Model names and base URLs are typed or pasted by hand, usually straight from
 * a documentation page or a console. Invisible characters ride along and then
 * produce failures that are impossible to see, because the value LOOKS correct
 * everywhere it is printed.
 *
 * String.trim() only removes whitespace. It leaves zero-width spaces, bidi
 * marks, soft hyphens and word joiners exactly where they are.
 */

// Every invisible/format character that realistically survives a copy-paste.
// Written as escapes on purpose: the literal characters would be unreadable
// (and un-reviewable) in the source.
const INVISIBLE = new RegExp(
  '[' +
  '\\u00AD' +               // soft hyphen
  '\\u034F' +               // combining grapheme joiner
  '\\u061C' +               // arabic letter mark
  '\\u115F\\u1160' +        // hangul fillers
  '\\u17B4\\u17B5' +        // khmer inherent vowels
  '\\u180B-\\u180E' +       // mongolian selectors + vowel separator
  '\\u200B-\\u200F' +       // zero-width space/NJ/J, LRM, RLM
  '\\u202A-\\u202E' +       // bidi embedding/override
  '\\u2060-\\u2064' +       // word joiner, invisible operators
  '\\u2066-\\u206F' +       // bidi isolates, deprecated format chars
  '\\u3164' +               // hangul filler
  '\\uFE00-\\uFE0F' +       // variation selectors
  '\\uFEFF' +               // BOM / zero-width no-break space
  '\\uFFA0' +               // halfwidth hangul filler
  ']', 'g',
)

// Spaces that are not U+0020 but read as one. Normalised so trimming works.
const ODD_SPACE = /[   -   　]/g

export function cleanValue(value) {
  return String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(ODD_SPACE, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
}

/** Base URLs additionally lose trailing slashes so path joining is predictable. */
export function cleanBaseUrl(value) {
  return cleanValue(value).replace(/\/+$/, '')
}

/**
 * Render a string so invisible characters BECOME VISIBLE, for error messages.
 * Without this, "this model name is invalid" is unusable advice when the
 * offending character cannot be seen.
 *
 *   describeHidden('gemini-2.5-flash​') -> 'gemini-2.5-flash\\u200B'
 */
export function describeHidden(value) {
  return String(value ?? '').replace(
    /[^\x20-\x7E]/g,
    (ch) => `\\u${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
}

/** True when the value carries something invisible that would break a URL. */
export const hasHiddenCharacters = (value) =>
  String(value ?? '') !== describeHidden(value)
