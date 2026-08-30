// Runs both Vite builds, then copies the static files Vite does not own.
//
//   npm run build            development build -> talks to http://localhost:8787
//   npm run build:release    release build     -> talks to $BACKEND_URL (must be https://)
//
// The backend URL is baked into the code (src/lib/env.js) AND added to the
// manifest's host_permissions; both halves must agree or Chrome blocks the
// request that completes the Notion sign-in.
import { build } from 'vite'
import { cp, readFile, writeFile } from 'node:fs/promises'

const watch = process.argv.includes('--watch')
const release = process.argv.includes('--release')
const outDir = process.env.OUT_DIR || 'dist'

const DEV_BACKEND_URL = 'http://localhost:8787'
const configured = (process.env.BACKEND_URL || process.env.NOTION_BACKEND_URL || '').trim()

if (release && !configured) {
  console.error('✖ A release build needs BACKEND_URL=https://<your-render-service>.onrender.com (put it in extension/.env or the environment).')
  process.exit(1)
}
if (release && !/^https:\/\//.test(configured)) {
  console.error(`✖ BACKEND_URL must be an https:// URL for a release build, got: ${configured}`)
  process.exit(1)
}

const BACKEND_URL = (configured || DEV_BACKEND_URL).replace(/\/+$/, '')
const isDev = !release && !configured

function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`
  } catch {
    throw new Error(`BACKEND_URL is not a valid URL: ${url}`)
  }
}

// Passed to vite.config.js through the environment: `define` is evaluated
// there, and this is the one place that decides the values.
process.env.__BUILD_BACKEND_URL = BACKEND_URL
process.env.__BUILD_IS_DEV = String(isDev)
process.env.__BUILD_OUT_DIR = outDir

await build({ configFile: 'vite.config.js', build: { watch: watch ? {} : null } })
await build({ configFile: 'vite.content.config.js', build: { watch: watch ? {} : null } })

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'))
const backendOrigin = originPattern(BACKEND_URL)
if (!manifest.host_permissions.includes(backendOrigin)) manifest.host_permissions.push(backendOrigin)
await writeFile(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)

await cp('public/icons', `${outDir}/icons`, { recursive: true })

console.log(`\n✅ Built ${manifest.name} v${manifest.version} -> extension/${outDir} (${isDev ? 'development' : 'release'})`)
console.log(`   Backend: ${BACKEND_URL}`)
if (isDev) console.log('   (development default — run `npm run build:release` with BACKEND_URL set for the published extension)')
console.log(`   Load extension/${outDir} in chrome://extensions (Developer mode -> Load unpacked)`)
