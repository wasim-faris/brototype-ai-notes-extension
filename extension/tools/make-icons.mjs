/**
 * Generates the extension icons as PNGs with no image library.
 * A PNG is just a header + a deflated bitmap + CRC checksums, so this is
 * about 40 lines and saves adding a dependency for three small files.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size)
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// An indigo rounded square with a white book/page mark.
const INDIGO = [79, 70, 229, 255]
const WHITE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

const icon = (x, y, size) => {
  const u = x / size, v = y / size
  const r = 0.18
  // rounded-corner mask
  const cx = Math.min(Math.max(u, r), 1 - r)
  const cy = Math.min(Math.max(v, r), 1 - r)
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return CLEAR

  // two white pages, slightly offset, with a spine gap between them
  const inPage = v > 0.28 && v < 0.76 && ((u > 0.2 && u < 0.475) || (u > 0.525 && u < 0.8))
  return inPage ? WHITE : INDIGO
}

mkdirSync('public/icons', { recursive: true })
for (const size of [16, 48, 128]) {
  writeFileSync(`public/icons/icon${size}.png`, png(size, icon))
  console.log(`public/icons/icon${size}.png`)
}
