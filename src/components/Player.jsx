// ──────────────────────────────────────────────
// src/components/Player.jsx
// Sticky-bottom audio HUD for AES-128 encrypted HLS.
//
// Streaming model (hardened, proxy-based, on-demand):
//   1. When a track is selected, call the `m3u8` Cloud
//      Function with the track id. It verifies the Firebase
//      ID token and returns the playlist text. The on-disk
//      m3u8 contains relative URIs (seg_000.ts / <id>.key).
//   2. Feed that text to hls.js as a Blob URL.
//   3. hls.js loads each segment/key ON DEMAND through a
//      custom loader that calls the `segment` Cloud Function
//      to fetch the bytes (base64) and returns them as a
//      Blob. Playback starts as soon as the FIRST segment
//      arrives — no pre-fetch of the whole track.
//   4. No Storage URL is ever exposed to the client; Storage
//      rules can stay fully auth-gated.
//
// Safari native HLS path: inline every segment/key as a
// data: URL into the m3u8, then feed the Blob to <audio>.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Fetch a segment/key via the `segment` Cloud Function and
// return a Blob URL for it. Caches by file name so seeks
// back to an already-played segment don't re-call the function.
function useSegmentFetcher(trackId) {
  const cacheRef = useRef(new Map())
  const segmentFnRef = useRef(null)
  if (!segmentFnRef.current) {
    segmentFnRef.current = httpsCallable(functions, 'segment')
  }

  const fetchUrl = useCallback(
    async (file, asDataUrl = false) => {
      const cache = cacheRef.current
      const cacheKey = `${file}:${asDataUrl}`
      const hit = cache.get(cacheKey)
      if (hit) return hit
      
      const { data } = await segmentFnRef.current({ id: trackId, file })
      
      let url
      if (asDataUrl) {
        url = `data:${data.contentType};base64,${data.base64}`
      } else {
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
        const blob = new Blob([bytes], { type: data.contentType })
        url = URL.createObjectURL(blob)
      }
      
      cache.set(cacheKey, url)
      return url
    },
    [trackId],
  )

  // Clear cache when the track changes.
  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const [key, url] of cache.entries()) {
        if (!key.endsWith(':true')) {
          URL.revokeObjectURL(url)
        }
      }
      cache.clear()
    }
  }, [trackId])

  return fetchUrl
}

// Rewrite an m3u8 so every segment/key URI is replaced with a
// data: URL carrying the bytes fetched via the `segment`
// Cloud Function. Used for the Safari native-HLS path, which
// cannot use xhrSetup.
async function inlineDataUrls(text, id, fetchUrl) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/)
    if (keyMatch) {
      const f = fileOf(keyMatch[1]) || keyMatch[1]
      try {
        const url = await fetchUrl(f, true)
        lines[i] = lines[i].replace(/URI="[^"]+"/, `URI="${url}"`)
      } catch {
        /* leave as-is */
      }
      continue
    }
    const bare = lines[i].trim()
    if (/^(seg_\d+\.ts|.+\.key)$/.test(bare)) {
      try {
        const url = await fetchUrl(bare, true)
        lines[i] = url
      } catch {
        /* leave as-is */
      }
    }
  }
  return lines.join('\n')
}

// Rewrite only the AES-128 key URI in an m3u8 to a Blob URL.
// The key file is tiny (~16 bytes), so pre-fetching it once per
// track is cheap. Segment URIs stay relative so hls.js loads
// them on demand through our custom fLoader.
async function inlineKeyOnly(text, fetchUrl) {
  const keyMatch = text.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/)
  if (!keyMatch) return text
  const f = fileOf(keyMatch[1]) || keyMatch[1]
  try {
    const url = await fetchUrl(f, false)
    return text.replace(/#EXT-X-KEY:METHOD=AES-128,URI="[^"]+"/, `#EXT-X-KEY:METHOD=AES-128,URI="${url}"`)
  } catch {
    return text
  }
}

// Extract the bare file name from an absolute Firebase Storage URL.
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

// Sum every #EXTINF:<seconds> line in an m3u8 manifest to get the
// real total duration. hls.js + Blob URL sources often report
// audio.duration === Infinity in Chrome (a known MSE quirk), so
// we fall back to this computed value for the scrubber + seek.
function durationFromM3u8(text) {
  if (!text) return 0
  let total = 0
  const re = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm
  let m
  while ((m = re.exec(text))) {
    total += parseFloat(m[1])
  }
  return total
}

function Equalizer({ playing }) {
  return (
    <div className="flex h-3.5 items-end gap-[3px]" aria-hidden>
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-1' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-2' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-3' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
      <span
        className={`w-[3px] origin-bottom rounded-full bg-ink-900 ${playing ? 'animate-eq-2' : 'h-1 opacity-50'}`}
        style={{ height: playing ? '100%' : undefined }}
      />
    </div>
  )
}

export default function Player({ track, onNext, onPrev }) {
  const audioRef = useRef(null)
  const hlsRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [seeking, setSeeking] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  // Buffered range, expressed as [start, end] in seconds, for
  // the "loaded" hint behind the playhead. Empty until we know.
  const [buffered, setBuffered] = useState({ start: 0, end: 0 })
  // Hover preview: the time under the cursor, shown as a
  // tooltip + faint vertical guide. null when not hovering.
  const [hoverTime, setHoverTime] = useState(null)

  const fetchUrl = useSegmentFetcher(track?.id)

  useEffect(() => {
    if (!track?.id || !audioRef.current) return
    const audio = audioRef.current
    let cancelled = false

    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const m3u8Fn = httpsCallable(functions, 'm3u8')

    ;(async () => {
      try {
        // 1. Fetch the m3u8 text via the auth-gated function.
        const { data } = await m3u8Fn({ id: track.id })
        if (cancelled) return
        const text = data.text

        // Compute the real duration from the manifest's #EXTINF
        // lines. Chrome reports audio.duration === Infinity for
        // hls.js + Blob URL sources (known MSE quirk), so we use
        // this as the authoritative duration for the scrubber.
        const manifestDuration = durationFromM3u8(text)
        if (manifestDuration > 0) setDuration(manifestDuration)

        if (Hls.isSupported()) {
          // hls.js path: feed the m3u8 as a Blob, and use a custom
          // fragment loader so each segment is fetched ON DEMAND via
          // the `segment` Cloud Function. The AES-128 key is tiny,
          // so we pre-resolve it to a Blob URL inside the manifest;
          // otherwise hls.js's default key loader tries to fetch the
          // relative `01INTRO.key` against the Blob URL base and 404s.
          const keyedText = await inlineKeyOnly(text, fetchUrl)
          if (cancelled) return
          const blobUrl = URL.createObjectURL(
            new Blob([keyedText], { type: 'application/vnd.apple.mpegurl' }),
          )
          // Custom FRAGMENT loader: hls.js assigns `frag.stats = loader.stats`
          // before calling load(), so the loader MUST expose a `stats` object
          // in the exact LoaderStats shape. We only intercept segment loads;
          // the manifest and AES-128 key are still fetched by hls.js's default
          // loader (the key URI is rewritten to a Blob URL in the manifest).
          class ProxyLoader {
            constructor(config) {
              this.config = config
              this.stats = this.createStats()
            }
            createStats() {
              return {
                aborted: false,
                loaded: 0,
                retry: 0,
                total: 0,
                chunkCount: 1,
                bwEstimate: 0,
                loading: { start: 0, first: 0, end: 0 },
                parsing: { start: 0, end: 0 },
                buffering: { start: 0, first: 0, end: 0 },
              }
            }
            abort() {
              if (this.controller) {
                this.controller.abort()
              }
            }
            destroy() {
              this.abort()
            }
            async load(context, config, callbacks) {
              const url = context.url || ''
              const file = url.split('/').pop().split('?')[0]
              
              // CRITICAL FIX: hls.js copies loader.stats to frag.stats BEFORE calling load(),
              // and reuses the loader instance. We MUST give this fragment a unique stats 
              // object immediately, otherwise all fragments share the same stats object!
              const stats = this.createStats()
              stats.loading.start = performance.now()
              
              if (context.frag) {
                context.frag.stats = stats
              }
              this.stats = stats
              
              console.log('[ProxyLoader] load started:', file)
              
              this.controller = new AbortController()

              stats.loading.start = performance.now()
              stats.loading.first = stats.loading.start

              try {
                const blobUrl = await fetchUrl(file, false)
                if (cancelled) return
                const res = await fetch(blobUrl, { signal: this.controller.signal })
                if (!res.ok) throw new Error(`fetch ${file} failed: ${res.status}`)
                
                let responseData
                if (context.responseType === 'text') {
                  responseData = await res.text()
                } else {
                  responseData = await res.arrayBuffer()
                }
                
                const now = performance.now()
                stats.loaded = responseData.byteLength || responseData.length
                stats.total = stats.loaded
                stats.loading.first = now
                stats.loading.end = now
                stats.parsing.end = now
                stats.buffering.end = now
                
                console.log(`[ProxyLoader] load success: ${file} (${stats.loaded} bytes)`)
                
                callbacks.onSuccess(
                  { url, data: responseData },
                  stats,
                  context,
                  null,
                )
              } catch (err) {
                if (err.name === 'AbortError' || this.controller.signal.aborted) {
                  console.log('[ProxyLoader] aborted:', file)
                  stats.aborted = true
                  callbacks.onAbort?.(stats, context, null)
                  return
                }
                console.warn('[player] loader fetch failed', file, err)
                callbacks.onError(
                  { code: 0, text: err?.message || 'proxy fetch failed' },
                  context,
                  null,
                )
              }
            }
          }

          const hls = new Hls({
            enableWorker: false,
            lowLatencyMode: false,
            // Only replace the fragment loader. Manifest + key use the default
            // fetch loader, which can handle the manifest Blob URL and the
            // pre-resolved key Blob URL without any custom code.
            fLoader: ProxyLoader,
          })

          hls.loadSource(blobUrl)
          hls.attachMedia(audio)
          hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
            console.log('[hls] MANIFEST_PARSED levels=', d.levels.length)
          })
          hls.on(Hls.Events.FRAG_LOADED, (_e, d) => {
            console.log('[hls] FRAG_LOADED', d.frag?.url, 'sn=', d.frag?.sn)
          })
          hls.on(Hls.Events.FRAG_PARSING_ERROR, (_e, d) => {
            console.warn('[hls] FRAG_PARSING_ERROR', d.details, d.reason)
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            // Ignore harmless bufferStalledError at the start of a track
            // caused by small PTS gaps. hls.js auto-recovers from this.
            if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR && audio.currentTime < 0.5) {
              return
            }
            console.warn('[hls] error', data.type, data.details, data.fatal ? 'FATAL' : '')
            if (data.fatal) console.warn('[hls] fatal', data.type, data.details)
          })

          // Auto-play once hls.js has attached to the media element
          // and the first fragment is buffered. Calling .play() too
          // early (before attachMedia finishes) leaves the audio
          // element with no source and the playhead never advances.
          const tryPlay = () => {
            console.log('[player] tryPlay called. cancelled:', cancelled)
            if (cancelled) return

            setPlaying(true)
            console.log('[player] calling audio.play()')
            audio.play().then(() => {
              console.log(`[player] audio.play() resolved. t=${audio.currentTime} readyState=${audio.readyState} paused=${audio.paused}`)
              
              // Fix Chrome MSE gap stall: if the decoded audio doesn't start
              // exactly at 0.00 (PTS offset), or if Chrome's audio renderer simply
              // gets stuck waiting for frames at 0.00 (a known issue for audio-only TS),
              // nudge the playhead slightly into the buffer AFTER play() has resolved.
              try {
                if (audio.buffered.length > 0) {
                  const start = audio.buffered.start(0)
                  if (audio.currentTime < start + 0.05) {
                    console.log(`[player] forcing playhead nudge to ${start + 0.05} to kickstart Chrome MSE`)
                    audio.currentTime = start + 0.05
                  }
                }
              } catch (e) {
                // ignore
              }
            }).catch((err) => {
              console.warn('[player] play rejected', err?.name, err?.message)
              setPlaying(false)
            })
          }
          hls.once(Hls.Events.MEDIA_ATTACHED, () => {
            console.log('[hls] MEDIA_ATTACHED')
            // Wait for the first fragment to be buffered so MSE
            // has data to decode; otherwise play() may stall.
            hls.once(Hls.Events.FRAG_BUFFERED, () => {
              console.log('[hls] FRAG_BUFFERED fired, calling tryPlay')
              tryPlay()
            })
          })

          if (!cancelled) hlsRef.current = hls
        } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS: inline every segment/key as a
          // data: URL into the m3u8, then feed the Blob to <audio>.
          const inlined = await inlineDataUrls(text, track.id, fetchUrl)
          if (cancelled) return
          audio.src = URL.createObjectURL(
            new Blob([inlined], { type: 'application/vnd.apple.mpegurl' }),
          )

          // Native HLS auto-play: wait for metadata, then play.
          setPlaying(true)
          audio.play().catch(() => {
            setPlaying(false)
            if (audio.readyState < 1) {
              const onReady = () => {
                audio.removeEventListener('loadedmetadata', onReady)
                setPlaying(true)
                audio.play().catch(() => setPlaying(false))
              }
              audio.addEventListener('loadedmetadata', onReady)
            }
          })
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[player] stream setup failed', err)
      }
    })()

    // Reset scrubber state for the new track.
    setCurrent(0)
    setBuffered({ start: 0, end: 0 })
    setHoverTime(null)

    return () => {
      cancelled = true
      if (hlsRef.current) {
        hlsRef.current.stopLoad()
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [track, fetchUrl])

  // Apply volume / mute changes WITHOUT restarting playback.
  // (Previously `volume` was in the main effect's deps, which
  // destroyed + rebuilt hls.js on every slider move.)
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onMeta = () => {
      // Only trust the audio element's duration if it's a
      // finite number. hls.js + Blob URL sources in Chrome
      // report Infinity, which would break the scrubber —
      // we keep the manifest-derived duration in that case.
      const d = audio.duration
      if (Number.isFinite(d) && d > 0) setDuration(d)
    }
    const onProgress = () => {
      // Take the last buffered range (closest to playhead) so
      // the "loaded" hint follows the same direction as the bar.
      try {
        const ranges = audio.buffered
        if (!ranges || ranges.length === 0) return
        const end = ranges.end(ranges.length - 1)
        // Find the range that contains or just precedes playhead.
        let start = 0
        for (let i = 0; i < ranges.length; i++) {
          if (ranges.start(i) <= audio.currentTime) {
            start = ranges.start(i)
          }
        }
        setBuffered({ start, end })
      } catch {
        /* ignore — older browsers */
      }
    }
    const onVol = () => {
      setVolume(audio.volume)
      setMuted(audio.muted)
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('progress', onProgress)
    audio.addEventListener('volumechange', onVol)

    // ── rAF time poll ──────────────────────────────────────
    // hls.js + Blob URL (MSE) sources in Chrome often fail to
    // fire `timeupdate` reliably, so the playhead never moves
    // on its own. Polling audio.currentTime every animation
    // frame is the robust fix — it's smooth (60fps) and works
    // regardless of whether the browser emits timeupdate.
    let rafId = 0
    let lastT = -1
    let logCounter = 0
    const tick = () => {
      const t = audio.currentTime
      if (++logCounter % 30 === 0) {
        console.log(`[tick] t=${t.toFixed(3)} paused=${audio.paused} readyState=${audio.readyState}`)
      }
      // Only write to state when the second actually changes,
      // to avoid 60 needless React re-renders per second.
      if (t !== lastT) {
        lastT = t
        if (!seekingRef.current) setCurrent(t)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('progress', onProgress)
      audio.removeEventListener('volumechange', onVol)
    }
  }, [])

  // Mirror `seeking` into a ref so the rAF tick above can read
  // the latest value without re-subscribing on every change
  // (which would cancel + restart the poll loop).
  const seekingRef = useRef(false)
  useEffect(() => {
    seekingRef.current = seeking
  }, [seeking])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    // Use the actual audio element state, not the React state,
    // to decide — but update React state immediately so the
    // icon flips without waiting for the event to fire.
    if (audio.paused || audio.ended) {
      setPlaying(true)
      // Do not try to wait for loadedmetadata here, because hls.js
      // tryPlay will automatically call play() when FRAG_BUFFERED fires.
      // Calling play() concurrently before MSE is ready can deadlock Chrome.
      audio.play().catch(() => setPlaying(false))
    } else {
      setPlaying(false)
      audio.pause()
    }
  }, [])

  const seekTo = useCallback(
    (clientX, rect) => {
      const audio = audioRef.current
      // Use the React `duration` (manifest-derived, finite)
      // instead of audio.duration, which is Infinity for
      // hls.js + Blob URL sources in Chrome.
      if (!audio || !duration || !rect) return null
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const t = ratio * duration
      audio.currentTime = t
      setCurrent(t)
      return t
    },
    [duration],
  )

  // ── Scrubber ─────────────────────────────────────────────
  // Replaces the old click-only progress bar. Adds:
  //   • drag-to-scrub (mouse + touch)
  //   • keyboard nav (←/→ 5s, Home/End, Shift+arrow 15s)
  //   • hover preview tooltip + vertical guide
  //   • visible playhead thumb at all times
  //   • loaded-buffer hint behind the progress fill
  //   • wider hit area (10px track, ~16px on hover) for mobile
  const scrubberRef = useRef(null)
  // Remember whether the track was playing when the user
  // started dragging, so we can resume on release.
  const wasPausedRef = useRef(true)

  const ratioToTime = useCallback(
    (clientX) => {
      const rect = scrubberRef.current?.getBoundingClientRect()
      if (!rect || !duration) return null
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration],
  )

  const startScrub = useCallback(
    (clientX) => {
      const audio = audioRef.current
      if (!audio || !duration) return
      const wasPaused = audio.paused
      setSeeking(true)
      const t = seekTo(clientX, scrubberRef.current?.getBoundingClientRect())
      if (t != null) setCurrent(t)
      // Pause while the user is dragging so playback doesn't
      // race the seek target. Resume on release if it was
      // playing before.
      if (!wasPaused) audio.pause()
      wasPausedRef.current = wasPaused
    },
    [duration, seekTo],
  )

  const moveScrub = useCallback(
    (clientX) => {
      if (!seeking) {
        // Pure hover — just update the preview tooltip.
        setHoverTime(ratioToTime(clientX))
        return
      }
      const t = seekTo(clientX, scrubberRef.current?.getBoundingClientRect())
      if (t != null) setCurrent(t)
    },
    [seeking, ratioToTime, seekTo],
  )

  const endScrub = useCallback(() => {
    if (!seeking) return
    setSeeking(false)
    // Resume if the track was playing before the drag.
    const audio = audioRef.current
    if (audio && !wasPausedRef.current) {
      audio.play().catch(() => setPlaying(false))
    }
  }, [seeking])

  // Mouse drag — listen on the window so the drag survives the
  // cursor leaving the bar.
  useEffect(() => {
    if (!seeking) return
    const onMove = (e) => {
      e.preventDefault()
      moveScrub(e.clientX)
    }
    const onUp = () => endScrub()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [seeking, moveScrub, endScrub])

  // Keyboard: ←/→ ±5s, Shift+arrow ±15s, Home/End jump.
  const onScrubberKey = useCallback(
    (e) => {
      const audio = audioRef.current
      if (!audio || !duration) return
      const big = e.shiftKey ? 15 : 5
      let next = audio.currentTime
      switch (e.key) {
        case 'ArrowLeft':
          next = Math.max(0, audio.currentTime - big)
          break
        case 'ArrowRight':
          next = Math.min(duration, audio.currentTime + big)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = duration
          break
        case ' ':
          // Space toggles play/pause when the bar is focused.
          e.preventDefault()
          togglePlay()
          return
        default:
          return
      }
      e.preventDefault()
      audio.currentTime = next
      setCurrent(next)
    },
    [duration, togglePlay],
  )

  const onSeek = useCallback(
    (e) => startScrub(e.clientX),
    [startScrub],
  )
  const onSeekTouch = useCallback(
    (e) => {
      const t = e.touches[0]
      if (t) startScrub(t.clientX)
    },
    [startScrub],
  )
  const onSeekTouchMove = useCallback(
    (e) => {
      const t = e.touches[0]
      if (t) moveScrub(t.clientX)
    },
    [moveScrub],
  )
  const onSeekTouchEnd = useCallback(() => endScrub(), [endScrub])

  const onVolume = useCallback((e) => {
    const audio = audioRef.current
    if (!audio) return
    const v = parseFloat(e.target.value)
    audio.volume = v
    audio.muted = v === 0
    setVolume(v)
  }, [])

  const toggleMute = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = !audio.muted
    setMuted(audio.muted)
  }, [])

  const progress = duration ? Math.min(100, (current / duration) * 100) : 0
  const bufferStartPct = duration
    ? Math.min(100, (buffered.start / duration) * 100)
    : 0
  const bufferEndPct = duration
    ? Math.min(100, (buffered.end / duration) * 100)
    : 0
  const hoverPct = hoverTime != null && duration
    ? Math.min(100, (hoverTime / duration) * 100)
    : null

  return (
    <div
      className={`glass border-t border-ink-700/40 ${track ? 'shadow-player' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Always render audio so the time-poll rAF + listeners (set up once with []) can attach to it at mount, even before first track */}
      <audio ref={audioRef} preload="metadata" onEnded={onNext} className="hidden" />

      {!track ? (
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 py-3 text-sm text-gray-500">
          <Equalizer playing={false} />
          <span>Select a track to start listening</span>
        </div>
      ) : (
        <>
          {/* Scrubber — drag, keyboard, hover preview, buffered hint */}
          <div
            ref={scrubberRef}
            className="group relative h-2.5 w-full cursor-pointer touch-none bg-ink-700/40"
            onMouseDown={onSeek}
            onMouseMove={(e) => {
              // Update hover preview whenever the user moves
              // inside the bar, even mid-drag (handled in moveScrub).
              if (!seeking) setHoverTime(ratioToTime(e.clientX))
            }}
            onMouseLeave={() => {
              if (!seeking) setHoverTime(null)
            }}
            onTouchStart={onSeekTouch}
            onTouchMove={onSeekTouchMove}
            onTouchEnd={onSeekTouchEnd}
            onTouchCancel={onSeekTouchEnd}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(current)}
            aria-valuetext={`${fmt(current)} of ${fmt(duration)}`}
            tabIndex={0}
            onKeyDown={onScrubberKey}
          >
            {/* Track baseline (slightly taller on hover for hit area) */}
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-700/60 transition-[height] duration-150 group-hover:h-1.5" />

            {/* Buffered range (loaded but not yet played) */}
            {bufferEndPct > bufferStartPct && (
              <div
                className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-500/60 transition-[height] duration-150 group-hover:h-1.5"
                style={{
                  left: `${bufferStartPct}%`,
                  width: `${Math.max(0, bufferEndPct - bufferStartPct)}%`,
                }}
              />
            )}

            {/* Hover preview guide (vertical line + tooltip) */}
            {hoverPct != null && (
              <>
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/40"
                  style={{ left: `${hoverPct}%` }}
                />
                <div
                  className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-ink-800/95 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-gray-100 shadow"
                  style={{ left: `${hoverPct}%` }}
                >
                  {fmt(hoverTime)}
                </div>
              </>
            )}

            {/* Played progress fill */}
            <div
              className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-accent via-accent-glow to-accent transition-[height] duration-150 group-hover:h-1.5"
              style={{ width: `${progress}%` }}
            />

            {/* Playhead thumb — always visible while playing or
                when the bar is interacted with; faded when idle
                but still grabbable for an easy target. */}
            <div
              className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-glow-sm ring-2 ring-accent/40 transition duration-150 ${
                playing || seeking || hoverPct != null
                  ? 'opacity-100 scale-100'
                  : 'opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100'
              }`}
              style={{ left: `${progress}%` }}
            />
          </div>

          {/* Single compact row */}
          <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
            {/* Art / equalizer — 44px (HIG min) */}
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-glow text-ink-900 shadow-glow-sm transition-shadow duration-300 ease-smooth ${
                playing ? 'shadow-glow' : ''
              }`}
              aria-hidden
            >
              {playing ? (
                <Equalizer playing />
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              )}
            </div>

            {/* Track meta */}
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold text-gray-100">
                {track.title}
              </p>
              <div className="flex items-center gap-1 text-[11px] tabular-nums text-gray-500 sm:text-xs">
                <span className="font-medium text-accent">{fmt(current)}</span>
                <span className="opacity-50">/</span>
                <span className="tabular-nums">{fmt(duration)}</span>
                <span className="hidden opacity-50 sm:inline">·</span>
                <span className="hidden truncate sm:inline">{track.artist}</span>
              </div>
            </div>

            {/* Transport — single row, compact */}
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <button
                onClick={onPrev}
                aria-label="Previous track"
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:scale-105 hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                </svg>
              </button>

              <button
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play'}
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-glow text-ink-900 shadow-glow transition-all duration-200 ease-smooth hover:scale-105 hover:shadow-glow-lg active:scale-95"
              >
                {playing ? (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" style={{ marginLeft: 2 }}>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                onClick={onNext}
                aria-label="Next track"
                className="flex h-11 w-11 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:scale-105 hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                  <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
                </svg>
              </button>
            </div>

            {/* Volume — desktop only */}
            <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <button
                onClick={toggleMute}
                aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-gray-400 transition-all duration-200 ease-smooth hover:bg-ink-700/60 hover:text-gray-100 active:scale-95"
              >
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={onVolume}
                aria-label="Volume"
                className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-ink-700 accent-accent lg:w-24"
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
