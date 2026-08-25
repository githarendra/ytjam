import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { socket } from "../socket.js";

const DRIFT_TOLERANCE_SEC = 3; // was 1.5 — too tight once real network latency/clock skew is in play
const SEEK_COOLDOWN_MS = 4000; // don't re-correct again until a previous seek has had time to settle
const YT_PLAYING = 1;
const YT_PAUSED = 2;

let apiLoadPromise = null;
function loadYouTubeAPI() {
  if (apiLoadPromise) return apiLoadPromise;
  apiLoadPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
  });
  return apiLoadPromise;
}

// `playback.updatedAt` is a timestamp from the SERVER's clock. Comparing it
// directly against this device's own Date.now() assumes both clocks agree —
// fine on a PC on the same network as the server, but a phone can easily be
// off by a couple of seconds (imprecise clock sync, or just asymmetric
// network latency between devices). That gap is exactly what shows up as
// video position drifting back and forth: each device computes a slightly
// different "correct" position and keeps re-seeking toward its own estimate.
// `clockOffsetMs` corrects for it — see measureClockOffset() below.
function projectedPosition(playback, clockOffsetMs) {
  if (!playback.isPlaying) return playback.positionSec;
  const elapsed = (Date.now() + clockOffsetMs - playback.updatedAt) / 1000;
  return playback.positionSec + elapsed;
}

/**
 * Renders the YouTube player and continuously reconciles local playback
 * against the room's server-truth `playback` state (the thing that makes
 * the "jam" actually stay in sync across listeners).
 *
 * `suspendSync` pauses reconciliation — used while the local user is
 * actively dragging the scrub bar, so the player doesn't fight their thumb.
 *
 * `onAutoplayBlocked(bool)` fires when the browser refuses a programmatic
 * play() call (e.g. this tab never had a direct click inside the embedded
 * player, so the browser won't let remote sync start audio here). When that
 * happens we fall back to muted playback — always allowed — so the tab at
 * least stays in sync visually, and let the parent show an "unmute" prompt.
 * The exposed `unmute()` handle is meant to be called from a real click.
 */
const Player = forwardRef(function Player(
  { playback, suspendSync, onTimeUpdate, onUserControl, onAutoplayBlocked },
  ref
) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const readyRef = useRef(false);
  const currentVideoRef = useRef(null);
  const playbackRef = useRef(playback);
  const suspendRef = useRef(suspendSync);
  const sampleRef = useRef({ value: 0, duration: 0, at: performance.now() });
  const onUserControlRef = useRef(onUserControl);
  const onAutoplayBlockedRef = useRef(onAutoplayBlocked);
  const suppressUntilRef = useRef(0); // ignore state-change echoes caused by our own reconcile() calls
  const clockOffsetRef = useRef(0); // ms to add to Date.now() to approximate the server's clock
  const lastSeekAtRef = useRef(0); // throttles corrective seeks so they have time to settle
  playbackRef.current = playback;
  suspendRef.current = suspendSync;
  onUserControlRef.current = onUserControl;
  onAutoplayBlockedRef.current = onAutoplayBlocked;

  useImperativeHandle(ref, () => ({
    unmute() {
      const player = playerRef.current;
      if (!player) return;
      player.unMute?.();
      player.setVolume?.(100);
      onAutoplayBlockedRef.current?.(false);
    },
  }));

  // Every programmatic play/pause/seek call below should mark a short window
  // during which onStateChange events are treated as "us", not the person.
  function suppressEcho() {
    suppressUntilRef.current = Date.now() + 900;
  }

  // Estimates how far this device's clock is from the server's, using a
  // simple round-trip ping. Run on mount and periodically — network
  // conditions (and therefore the useful precision) can shift, especially
  // on a phone moving between WiFi and cellular.
  function measureClockOffset() {
    const sentAt = Date.now();
    socket.emit("time-sync", null, (serverNow) => {
      const receivedAt = Date.now();
      const roundTrip = receivedAt - sentAt;
      // Assume the request and response each took half the round trip —
      // a rough estimate, but averaging several samples smooths out noise
      // better than trusting any single measurement.
      const estimatedServerNow = serverNow + roundTrip / 2;
      const sample = estimatedServerNow - receivedAt;
      clockOffsetRef.current = clockOffsetRef.current === 0 ? sample : clockOffsetRef.current * 0.7 + sample * 0.3;
    });
  }

  // Browsers only allow programmatic play() with sound if this tab has had
  // a direct user gesture inside the (cross-origin) player itself — clicking
  // our own buttons doesn't count. If a play() call doesn't actually take
  // within a beat, assume it was blocked and retry muted, which is always
  // allowed, so this tab doesn't just silently fall out of sync.
  // Distinguishes "still buffering" (normal, especially on a fresh load) from
  // "the browser is actually refusing to play here" (genuine autoplay block) —
  // a single quick check would false-positive on ordinary buffering and mute
  // audio that would have started fine on its own a moment later.
  const verifyingRef = useRef(false);
  function verifyPlaybackStarted() {
    if (verifyingRef.current) return; // a check is already in flight
    verifyingRef.current = true;

    const YT_BUFFERING = 3;
    const YT_CUED = 5;
    const YT_UNSTARTED = -1;
    const delays = [800, 1500, 2500]; // ~4.8s total before concluding it's blocked

    function check(step) {
      const player = playerRef.current;
      if (!player || !player.getPlayerState || !playbackRef.current.isPlaying) {
        verifyingRef.current = false;
        return;
      }
      const state = player.getPlayerState();
      if (state === YT_PLAYING) {
        verifyingRef.current = false; // it caught up on its own — nothing to do
        return;
      }

      const stillLoading = state === YT_BUFFERING || state === YT_CUED || state === YT_UNSTARTED;
      if (stillLoading && step < delays.length - 1) {
        setTimeout(() => check(step + 1), delays[step]);
        return;
      }

      // Exhausted the grace period and it's still not playing — that's the
      // signature of a genuine autoplay block, not just a slow connection.
      suppressEcho();
      player.mute?.();
      player.playVideo();
      onAutoplayBlockedRef.current?.(true);
      verifyingRef.current = false;
    }

    setTimeout(() => check(0), delays[0]);
  }

  useEffect(() => {
    let cancelled = false;
    loadYouTubeAPI().then((YT) => {
      if (cancelled || !containerRef.current) return;
      playerRef.current = new YT.Player(containerRef.current, {
        videoId: playbackRef.current.videoId || undefined,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            readyRef.current = true;
            currentVideoRef.current = playbackRef.current.videoId;
            reconcile(playbackRef.current);
          },
          // Fires for both our own programmatic calls AND the person clicking
          // YouTube's own pause/play overlay or hitting spacebar. The suppress
          // window is what tells those two apart — real user actions outside
          // that window get forwarded so the whole room stays in sync instead
          // of the reconcile loop "fighting" them a few seconds later.
          onStateChange: (e) => {
            if (Date.now() < suppressUntilRef.current) return;
            if (e.data === YT_PLAYING) onUserControlRef.current?.("play");
            else if (e.data === YT_PAUSED) onUserControlRef.current?.("pause");
          },
        },
      });
    });

    // Corrects drift periodically even when no new sync event has arrived.
    const reconcileInterval = setInterval(() => {
      if (!suspendRef.current) reconcile(playbackRef.current);
    }, 3000);

    // Keeps the clock-offset estimate current — cheap, and worth refreshing
    // periodically since network conditions (and thus the round-trip
    // estimate's accuracy) can drift, especially on mobile.
    measureClockOffset();
    const clockSyncInterval = setInterval(measureClockOffset, 20000);

    // Samples the real player position at a moderate rate — querying the
    // iframe over postMessage on every animation frame would be wasteful.
    const sampleInterval = setInterval(() => {
      const player = playerRef.current;
      if (!readyRef.current || !player?.getCurrentTime || suspendRef.current) return;
      sampleRef.current = {
        value: player.getCurrentTime(),
        duration: player.getDuration?.() || 0,
        at: performance.now(),
      };
    }, 250);

    // Interpolates between samples every frame so the scrub bar glides
    // smoothly instead of visibly jumping every 250ms.
    let rafId;
    let lastEmit = 0;
    function tick(now) {
      if (!suspendRef.current && now - lastEmit > 33) {
        // ~30fps is smooth to the eye and cheaper than re-rendering at 60fps
        lastEmit = now;
        const { value, duration, at } = sampleRef.current;
        const elapsed = (performance.now() - at) / 1000;
        const interpolated = duration ? Math.min(value + elapsed, duration) : value + elapsed;
        onTimeUpdate?.(interpolated, duration);
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      clearInterval(reconcileInterval);
      clearInterval(clockSyncInterval);
      clearInterval(sampleInterval);
      cancelAnimationFrame(rafId);
      playerRef.current?.destroy?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reconcile(pb) {
    const player = playerRef.current;
    if (!player || !readyRef.current || !player.getPlayerState || !pb.videoId) return;

    if (currentVideoRef.current !== pb.videoId) {
      currentVideoRef.current = pb.videoId;
      suppressEcho();
      lastSeekAtRef.current = Date.now();
      player.loadVideoById(pb.videoId, projectedPosition(pb, clockOffsetRef.current));
      if (!pb.isPlaying) {
        setTimeout(() => {
          suppressEcho();
          player.pauseVideo?.();
        }, 400);
      } else {
        verifyPlaybackStarted();
      }
      return;
    }

    const target = projectedPosition(pb, clockOffsetRef.current);
    const current = player.getCurrentTime?.() ?? 0;
    const sinceLastSeek = Date.now() - lastSeekAtRef.current;
    const drift = Math.abs(current - target);
    // A big drift (e.g. someone just seeked) corrects immediately; a smaller
    // one waits out the cooldown so a still-settling previous correction
    // doesn't get "fought" by the very next reconcile tick — that fight is
    // what shows up as the video visibly jumping back and forth.
    if (drift > DRIFT_TOLERANCE_SEC && (drift > 6 || sinceLastSeek > SEEK_COOLDOWN_MS)) {
      suppressEcho();
      lastSeekAtRef.current = Date.now();
      player.seekTo(target, true);
    }

    const state = player.getPlayerState();
    if (pb.isPlaying && state !== YT_PLAYING) {
      suppressEcho();
      player.playVideo();
      verifyPlaybackStarted();
    }
    if (!pb.isPlaying && state !== YT_PAUSED && state !== -1) {
      suppressEcho();
      player.pauseVideo();
    }
  }

  useEffect(() => {
    if (!suspendSync) reconcile(playback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.videoId, playback.isPlaying, playback.positionSec, playback.updatedAt]);

  return (
    <div className="player-video">
      <div ref={containerRef} />
    </div>
  );
});

export default Player;
