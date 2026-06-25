# 🎧 Hudson

A private, invite-only music player for streaming your band's repertoire securely. Built with **React + Vite + Tailwind CSS + Firebase (Auth + Storage + Cloud Functions)** and an **AES-128 encrypted HLS** backend with **short-lived signed URLs** so the underlying audio cannot be scraped or hotlinked.

## ✨ Features

- 🔐 **Email/Password auth** — accounts created in the Firebase Console; no shared password in the bundle, no anonymous sign-in.
- 🌑 **Dark, sleek UI** — Tailwind-powered, gradient brand, sticky bottom audio player.
- 🛡️ **Anti-download / anti-scrape stack**
  1. Tracks are transcoded into HLS `.ts` segments.
  2. Each segment is **AES-128 encrypted** with a per-track key (`scripts/encrypt_hls.sh`).
  3. The AES key and all segments live behind Firebase Storage rules that require `request.auth != null` — **no public read anywhere**.
  4. The client never holds long-lived URLs. A **Cloud Function token proxy** (`functions/index.js`) mints **15-minute V4 signed URLs** on demand for the m3u8 and for every segment/key, after verifying the caller's Firebase ID token.
  5. The on-disk m3u8s contain only **relative** file names (`scripts/relativize_m3u8.mjs`) — no baked-in tokens.
  6. CORS is locked to the hosting origin, so the bucket cannot be hotlinked from other sites.
  7. `<audio>` uses `controlsList="nodownload"`, right-click is blocked, drag is blocked, and Safari native HLS plays via a `Blob` URL so the signed URL never appears in DevTools.

## 📁 Folder structure

```
hudson/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── cors.json             ← Storage CORS (locked to hosting origin)
├── firebase.json         ← hosting + storage + functions
├── storage.rules         ← auth-gated Storage security rules
├── functions/            ← Cloud Functions (token proxy)
│   ├── package.json
│   └── index.js          ← catalogue / stream / segment callables
├── hls_build/            ← generated HLS output (segments + keys, gitignored)
├── mp3_export/           ← source MP3s (used by encrypt_hls.sh)
├── scripts/
│   ├── encrypt_hls.sh     ← MP3 → AES-128 HLS segments + key
│   ├── upload_hls.mjs     ← push segments + keys + m3u8 to Storage
│   └── relativize_m3u8.mjs ← rewrite m3u8 URIs to relative file names
└── src/
    ├── main.jsx          ← entry point
    ├── App.jsx           ← routes
    ├── index.css         ← Tailwind + global styles
    ├── firebase.js       ← Firebase init (auth + storage + functions)
    ├── context/
    │   └── AuthContext.jsx
    ├── components/
    │   ├── PrivateRoute.jsx
    │   ├── Player.jsx     ← token-proxy-backed hls.js player
    │   └── Playlist.jsx
    └── pages/
        ├── Login.jsx
        └── Home.jsx       ← main player screen (catalogue via Cloud Function)
```

## 🚀 Getting started

### 1. Install dependencies

```bash
npm install
cd functions && npm install && cd ..
```

### 2. Configure Firebase

1. [Firebase Console](https://console.firebase.google.com/) → create a project (e.g. `hudson`).
2. **Authentication → Sign-in method → enable Email/Password.** (Do NOT enable Anonymous — the Cloud Function rejects it.)
3. **Storage → Get started** (bucket in any region).
4. **Project Settings → Your apps → Web app** → copy the config values.
5. Copy `.env.example` to `.env` and paste the values.
6. **Create member accounts** under Authentication → Users → Add user. Only these accounts can stream.

### 3. Apply Storage security rules + CORS

```bash
firebase deploy --only storage
gsutil cors set cors.json gs://hudson-65e88.firebasestorage.app
```

`storage.rules` denies every path by default and only opens `/keys/**` and `/tracks-hls/**` to authenticated users (`request.auth != null`).

### 4. Deploy the Cloud Functions

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

This deploys three callable functions: `catalogue`, `stream`, `segment`. Each verifies the caller's Firebase ID token and rejects anonymous auth.

### 5. Generate HLS, encrypt, upload, relativize

```bash
# 1. Drop source MP3s into mp3_export/
# 2. Encrypt + segment into hls_build/
bash scripts/encrypt_hls.sh
# 3. Upload segments + AES keys + m3u8 to Storage
node scripts/upload_hls.mjs
# 4. Rewrite every m3u8 to relative URIs (no baked tokens)
node scripts/relativize_m3u8.mjs
# 5. Re-upload the relativized m3u8s
node scripts/upload_hls.mjs
```

The client never touches the Admin SDK, never sees the service-account JSON, and never holds a long-lived URL. Every streaming URL is minted on demand by the Cloud Function and expires in 15 minutes.

### 6. Run

```bash
npm run dev
```

Open http://localhost:5173.

## 🛡️ Security model

| Layer | What it stops |
|-------|---------------|
| Email/password auth (no anonymous) | Shared-password scraping; the password is never in the bundle |
| `storage.rules` (`request.auth != null`, default deny) | Unauthenticated requests return 403 — no public reads anywhere |
| Cloud Function token proxy | Verifies Firebase ID token on every `catalogue` / `stream` / `segment` call; rejects anonymous |
| 15-minute V4 signed URLs | A leaked URL becomes useless within minutes; the Storage rule still blocks replay without a session |
| Relative m3u8 URIs | No long-lived tokens baked into playlists; segments are resolved per-request via the proxy |
| CORS locked to hosting origin | Hotlinking from other sites / bandwidth theft |
| `controlsList="nodownload"` + right-click + drag block | Casual "Save audio as…" attempts |
| Safari native HLS via `Blob` URL | The signed URL never appears in DevTools / Network tab |

> ⚠️ Client-side measures deter casual users but cannot fully prevent a determined attacker who can capture decrypted audio post-DSP. For true DRM, use Widevine/FairPlay/PlayReady with a license server. The current model raises the bar from "one `curl | ffmpeg`" to "authenticated session + per-segment token rotation + short-lived URLs," which is appropriate for a private band repertoire.

## 🏗️ Build & deploy

```bash
npm run build
firebase deploy --only hosting
```

Live URL after deploy: shown in the Firebase CLI output (e.g. `https://hudson-65e88.web.app`).

---

Made for the band. 🎶# HudsonPlayer
