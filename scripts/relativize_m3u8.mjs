#!/usr/bin/env node
/* ──────────────────────────────────────────────
 * scripts/relativize_m3u8.mjs
 *
 * Rewrites every hls_build/segments/<safe>/index.m3u8 so
 * that segment and key URIs are RELATIVE file names
 * (seg_000.ts, <safe>.key) instead of absolute signed
 * Firebase Storage URLs.
 *
 * Run AFTER upload_hls.mjs (and instead of sign_m3u8.mjs):
 *   node scripts/relativize_m3u8.mjs
 *
 * Then re-upload the relativized playlists:
 *   node scripts/upload_hls.mjs   # re-uploads segments + m3u8
 *
 * Why: the new Cloud Function token proxy mints short-lived
 * signed URLs on demand. The on-disk m3u8 must therefore
 * contain only relative names — no long-lived tokens baked
 * in, no public playlists.json manifest.
 * ────────────────────────────────────────────── */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SEG_ROOT = 'hls_build/segments'

function fileOf(url) {
  try {
    const u = new URL(url)
    const enc = u.pathname.split('/o/')[1]
    if (!enc) return null
    return decodeURIComponent(enc).split('/').pop()
  } catch {
    return null
  }
}

function relativize(text) {
  return text
    .replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/,
      (_, uri) => {
        const f = fileOf(uri)
        return `#EXT-X-KEY:METHOD=AES-128,URI="${f || uri}"`
      },
    )
    .replace(/^https:\/\/[^\s]+$/gm, (uri) => fileOf(uri) || uri)
}

const dirs = (await readdir(SEG_ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

let count = 0
for (const safe of dirs) {
  const p = join(SEG_ROOT, safe, 'index.m3u8')
  let text
  try {
    text = await readFile(p, 'utf8')
  } catch {
    continue
  }
  const rel = relativize(text)
  await writeFile(p, rel)
  count++
  process.stdout.write(`\r[${count}/${dirs.length}] ${safe}`)
}
console.log(`\n✓ ${count} playlists relativized → ${SEG_ROOT}`)
console.log('  Re-run upload_hls.mjs to push the relativized m3u8s.')