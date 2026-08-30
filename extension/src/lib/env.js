/**
 * Which backend this build of the extension talks to - for BOTH the Notion
 * sign-in and AI generation. Baked in at build time, so no user ever types a
 * URL and no source file has to change between development and release:
 *
 *   npm run build                                      -> http://localhost:8787 (development)
 *   BACKEND_URL=https://… npm run build:release        -> that server (the published extension)
 *
 * build.js also adds the matching host_permissions entry, so the packaged
 * extension is allowed to talk to exactly the server it was built for.
 *
 * A stored override (Notion -> Advanced, development builds only) can point at
 * a scratch server; an empty stored value means "whatever this build was made
 * for", so nothing stale can pin a release build to a developer's machine.
 */

// Both identifiers are replaced textually by Vite's `define`. When this file
// is imported by Node directly (the tests), neither exists and the development
// values apply.
export const DEFAULT_BACKEND_URL = typeof __BACKEND_URL__ === 'string' ? __BACKEND_URL__ : 'http://localhost:8787'

/** True for a development build (no BACKEND_URL given at build time). */
export const IS_DEV_BUILD = typeof __DEV_BUILD__ === 'boolean' ? __DEV_BUILD__ : true

/** The only override a release build accepts is another https server. */
export const acceptableOverride = (url) => {
  const value = String(url || '').trim()
  if (!value) return ''
  if (!IS_DEV_BUILD && !/^https:\/\//i.test(value)) return ''
  return value
}

/** The backend to actually use: an acceptable explicit override, else this build's own. */
export const resolveBackendUrl = (config) =>
  acceptableOverride(config?.notionOAuthBackendUrl) || DEFAULT_BACKEND_URL
