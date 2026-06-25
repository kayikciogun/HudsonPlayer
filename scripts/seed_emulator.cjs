#!/usr/bin/env node
/* ──────────────────────────────────────────────
 * scripts/seed_emulator.cjs
 *
 * Uploads a few HLS tracks + their AES keys to the
 * Firebase Storage emulator (127.0.0.1:9199) so the
 * catalogue/m3u8/segment Cloud Functions can serve them
 * during local testing.
 *
 *   node scripts/seed_emulator.cjs [trackId ...]
 *
 * Defaults to seeding 01INTRO and 02LUNA.
 * ────────────────────────────────────────────── */
const { readdir, readFile } = require('node:fs/promises')
const { join } = require('node:path')
const admin = require('../functions/node_modules/firebase-admin')

const BUCKET = 'hudson-65e88.firebasestorage.app'
const SEG_ROOT = 'hls_build/segments'
const KEY_DIR = 'hls_build/keys'

// Point the Admin SDK at the Storage emulator.
process.env.FIRE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9199'

admin.initializeApp({ projectId: 'hudson-65e88' })
const bucket = admin.storage().bucket(BUCKET)

const tracks = process.argv.slice(2)
if (tracks.length === 0) tracks.push('01INTRO', '02LUNA')

async function upload(localPath, remotePath, contentType) {
  const buf = await readFile(localPath)
  const f = bucket.file(remotePath)
  await f.save(buf, {
    contentType,
    metadata: { contentType },
  })
  process.stdout.write(`  ✓ ${remotePath}\n`)
}

;(async () => {
  for (const id of tracks) {
    console.log(`\n→ ${id}`)
    const segDir = join(SEG_ROOT, id)
    let files
    try {
      files = await readdir(segDir)
    } catch {
      console.error(`  ✗ no such dir: ${segDir}`)
      continue
    }
    for (const f of files) {
      const ct = f.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t'
      await upload(join(segDir, f), `tracks-hls/${id}/${f}`, ct)
    }
    // key
    const keyPath = join(KEY_DIR, `${id}.key`)
    try {
      await upload(keyPath, `keys/${id}.key`, 'application/octet-stream')
    } catch {
      console.error(`  ✗ no key at ${keyPath}`)
    }
  }
  console.log('\n✓ seed complete')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})