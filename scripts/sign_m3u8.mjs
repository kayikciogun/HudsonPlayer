#!/usr/bin/env node
/* ──────────────────────────────────────────────
 * scripts/sign_m3u8.mjs
 *
 * For every track folder under hls_build/segments/<safe>/:
 *   1. Generate a long-lived Firebase Storage media
 *      download token for each .ts segment and the AES key
 *      (admin OAuth, no expiry).
 *   2. Rewrite the local index.m3u8 in place so every
 *      segment line and the EXT-X-KEY URI are absolute
 *      signed URLs of the form
 *        https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded>?alt=media&token=<uuid>
 *   3. Re-upload the patched index.m3u8 to Storage (media
 *      upload, OAuth bearer).
 *   4. Emit mp3_export/playlists.json — a single file the
 *      client can fetch to learn every track's signed
 *      playlist URL without ever touching the Admin SDK.
 *
 * Run after upload_hls.mjs:
 *   node scripts/sign_m3u8.mjs
 * ────────────────────────────────────────────── */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'

const BUCKET = 'hudson-65e88.firebasestorage.app'
const SEG_ROOT = 'hls_build/segments'
const SA = JSON.parse(
  await readFile('hudson-65e88-firebase-adminsdk-fbsvc-b9a9653d5f.json', 'utf8'),
)

// 1. Admin OAuth token (cloud-platform scope, 1h)
const now = Math.floor(Date.now() / 1000)
const assertion = jwt.sign(
  {
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: SA.token_uri,
    iat: now,
    exp: now + 3600,
  },
  SA.private_key,
  { algorithm: 'RS256' },
)
const tRes = await fetch(SA.token_uri, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
})
if (!tRes.ok) {
  console.error('✗ admin token exchange failed:', await tRes.text())
  process.exit(1)
}
const { access_token } = await tRes.json()
console.log('✓ admin token acquired')

// 2. Upload a local file to Firebase Storage and return a
//    signed download URL. Uses the Firebase Storage REST API
//    (firebasestorage.googleapis.com/v0/b/.../o/<path>) which
//    mints a downloadTokens UUID on every upload. The GCS API
//    (storage.googleapis.com) does NOT return downloadTokens,
//    so we must use the Firebase endpoint here.
async function uploadAndSign(localPath, remotePath, contentType) {
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(
    remotePath,
  )}`
  const buf = await readFile(localPath)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': contentType,
      'Content-Length': buf.length.toString(),
    },
    body: buf,
  })
  if (!res.ok) throw new Error(`upload ${remotePath}: ${res.status} ${await res.text()}`)
  const j = await res.json()
  if (!j.downloadTokens) {
    throw new Error(`no downloadTokens returned for ${remotePath}: ${JSON.stringify(j)}`)
  }
  const token = j.downloadTokens.split(',')[0]
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(
    remotePath,
  )}?alt=media&token=${token}`
}

const trackDirs = (await readdir(SEG_ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

let idx = 0
const total = trackDirs.length
const concurrency = 6
const playlists = {}

async function worker() {
  while (idx < total) {
    const my = idx++
    const safe = trackDirs[my]
    const dir = join(SEG_ROOT, safe)
    const m3u8Path = join(dir, 'index.m3u8')

    const segFiles = (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort()

    // Upload segments + key (gets fresh download tokens).
    // Segments are re-uploaded from disk so their content is
    // preserved and a new token is minted in one shot.
    const segUrls = await Promise.all(
      segFiles.map(async (f) => [
        f,
        await uploadAndSign(
          join(dir, f),
          `tracks-hls/${safe}/${f}`,
          'video/mp2t',
        ),
      ]),
    )
    const keyUrl = await uploadAndSign(
      join('hls_build/keys', `${safe}.key`),
      `keys/${safe}.key`,
      'application/octet-stream',
    )

    // Rewrite playlist: signed segment URLs + signed key URI
    let m3u8 = await readFile(m3u8Path, 'utf8')
    m3u8 = m3u8.replace(
      /#EXT-X-KEY:METHOD=AES-128,URI="[^"]+",IV=([0-9A-Fx]+)/,
      (_, iv) => `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=${iv}`,
    )
    for (const [f, url] of segUrls) {
      m3u8 = m3u8.replace(new RegExp(`^${f}$`, 'm'), url)
    }
    await writeFile(m3u8Path, m3u8)

    // Upload the rewritten playlist and sign it in one shot.
    const playlistUrl = await uploadAndSign(
      m3u8Path,
      `tracks-hls/${safe}/index.m3u8`,
      'application/vnd.apple.mpegurl',
    )

    playlists[safe] = playlistUrl
    process.stdout.write(`\r[${idx}/${total}] ${safe}`)
  }
}

await Promise.all(Array.from({ length: concurrency }, worker))
console.log('\n✓ m3u8s signed + re-uploaded')

// 4. Emit playlists.json to BOTH mp3_export/ and public/
//    (Vite copies public/ into the hosting bundle at build time,
//    so the client fetches it as a normal static asset — no token,
//    no CORS dance, no Storage dependency for the manifest itself.)
const manifest = {
  bucket: BUCKET,
  generatedAt: new Date().toISOString(),
  tracks: trackDirs.map((safe) => ({
    id: safe,
    url: playlists[safe],
  })),
}
await writeFile('mp3_export/playlists.json', JSON.stringify(manifest, null, 2))
await writeFile('public/playlists.json', JSON.stringify(manifest, null, 2))
console.log('✓ public/playlists.json written (used by client at build time)')