#!/usr/bin/env node
/* ──────────────────────────────────────────────
 * scripts/upload_hls.mjs
 * Uploads HLS segments + AES keys to Firebase Storage
 * using a Service Account JSON (signed JWT for OAuth).
 *
 *   node scripts/upload_hls.mjs
 * ────────────────────────────────────────────── */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, basename } from 'node:path'
import { existsSync } from 'node:fs'
import jwt from 'jsonwebtoken'

const BUCKET = 'hudson-65e88.firebasestorage.app'
const SEG_ROOT = 'hls_build/segments'
const KEY_DIR = 'hls_build/keys'
const CONCURRENCY = 12

// Locate service account JSON
const candidates = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  'hudson-65e88-firebase-adminsdk-fbsvc-b9a9653d5f.json',
].filter(Boolean)
const SA_PATH = candidates.find((p) => p && existsSync(p))
if (!SA_PATH) {
  console.error('✗ service account JSON not found in:', candidates)
  process.exit(1)
}
console.log(`→ using ${basename(SA_PATH)}`)

// 1. Authenticate via signed JWT → OAuth2 token
const sa = JSON.parse(await readFile(SA_PATH, 'utf8'))
const now = Math.floor(Date.now() / 1000)
const payload = {
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/devstorage.read_write',
  aud: sa.token_uri,
  iat: now,
  exp: now + 3600,
}
const assertion = jwt.sign(payload, sa.private_key, { algorithm: 'RS256' })
const tokenRes = await fetch(sa.token_uri, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
})
if (!tokenRes.ok) {
  console.error('✗ token exchange failed', await tokenRes.text())
  process.exit(1)
}
const { access_token: TOKEN } = await tokenRes.json()
console.log('✓ authenticated')

// 2. Walk directories, build upload list
async function walk(root) {
  const out = []
  async function recurse(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await recurse(p)
      else out.push(p)
    }
  }
  await recurse(root)
  return out
}

// Optional CLI args: node upload_hls.mjs 35FİNGERSNAP 36ÖP ...
// If given, only those track folders + their keys are uploaded.
const onlyIds = process.argv.slice(2)

let segments = (await walk(SEG_ROOT)).filter(
  (f) => f.endsWith('.ts') || f.endsWith('.m3u8'),
)
let keys = (await walk(KEY_DIR)).filter((f) => f.endsWith('.key'))

if (onlyIds.length > 0) {
  segments = segments.filter((f) =>
    onlyIds.some((id) => f.includes(`${SEG_ROOT}/${id}/`)),
  )
  keys = keys.filter((f) =>
    onlyIds.some((id) => f.endsWith(`${id}.key`)),
  )
}

console.log(`  ${segments.length} segments, ${keys.length} keys`)

// 3. Upload worker
let done = 0
const total = segments.length + keys.length
const start = Date.now()

async function upload(localPath, remotePath, contentType) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(
    remotePath,
  )}`
  const buf = await readFile(localPath)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': contentType,
      'Content-Length': buf.length.toString(),
    },
    body: buf,
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${txt.slice(0, 200)}`)
  }
  done++
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  process.stdout.write(`\r  [${done}/${total}] ${elapsed}s  ${basename(localPath)}`)
}

// 4. Run with bounded concurrency
async function pool(items, mapper, n) {
  const iter = items[Symbol.iterator]()
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const { value, done } = iter.next()
      if (done) return
      await mapper(value)
    }
  })
  await Promise.all(workers)
}

console.log('→ uploading segments to tracks-hls/...')
await pool(
  segments,
  async (f) => {
    const rel = relative(SEG_ROOT, f)
    await upload(f, `tracks-hls/${rel}`, f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
  },
  CONCURRENCY,
)
console.log('\n→ uploading keys to keys/...')
await pool(
  keys,
  async (f) => {
    const name = basename(f)
    await upload(f, `keys/${name}`, 'application/octet-stream')
  },
  CONCURRENCY,
)
console.log('\n✓ all done')
if (onlyIds.length > 0) {
  console.log(`  (only: ${onlyIds.join(', ')})`)
}