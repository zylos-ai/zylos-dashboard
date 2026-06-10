import { stateMood } from './agent-fleet.js';

const STORAGE_KEY = 'fleet-sounds-muted';
const WORKING_MOODS = new Set(['busy', 'thinking']);

export function isWorkingMood(mood) {
  return WORKING_MOODS.has(mood);
}

// Diffs the previous per-agent mood map against a fresh fleet payload.
// Agents seen for the first time seed the map silently, so a page load (or an
// agent joining the fleet) never fires a burst of cues. busy<->thinking is not
// a transition, and working->stuck/offline deliberately skips the finish cue —
// that state gets surfaced visually, a "done" chime would be misleading.
export function computeFleetTransitions(prevMoods, agents) {
  const moods = new Map();
  const started = [];
  const finished = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const name = String(agent?.name || '');
    if (!name) continue;
    const mood = stateMood(agent);
    moods.set(name, mood);
    const prev = prevMoods instanceof Map ? prevMoods.get(name) : undefined;
    if (prev === undefined) continue;
    if (!isWorkingMood(prev) && isWorkingMood(mood)) started.push(name);
    else if (isWorkingMood(prev) && mood === 'idle') finished.push(name);
  }
  return { moods, started, finished };
}

function loadMuted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Default muted: the wall should never make noise unprompted.
    return raw == null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function createFleetSounds({ button, labels, mediaDevices, doc } = {}) {
  let muted = loadMuted();
  let prevMoods = new Map();
  let audioCtx = null;
  const devices = mediaDevices !== undefined
    ? mediaDevices
    : (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  const docRef = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : undefined);

  function ensureContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      // Chrome binds a context's output to the device that was default at
      // creation and won't follow later changes on its own. Pinning the sink
      // to '' (the UA default) makes the routing explicit where supported
      // (Chrome 110+); rebinding on device changes is handled below.
      if (typeof audioCtx.setSinkId === 'function') {
        audioCtx.setSinkId('').catch(() => {});
      }
    }
    return audioCtx;
  }

  // Re-setting an identical sinkId is a spec'd no-op, so the only reliable way
  // to rebind after the system default output changes (devicechange fires for
  // that — the UA's virtual default device entry updates) is to drop the
  // context and build a fresh one, which binds to the new default at creation.
  function handleDeviceChange() {
    if (!audioCtx) return;
    const old = audioCtx;
    audioCtx = null;
    old.close?.().catch?.(() => {});
    if (!muted) ensureContext();
  }

  // Browsers keep a fresh AudioContext suspended until a user gesture. The
  // bell click unlocks it, but on pages without the unmute interaction (a
  // reload with the preference already on, a remote agent detail page) cues
  // would stay queued and expire. Any click on the page is a qualifying
  // gesture — use it to resume.
  function handlePointerDown() {
    if (muted) return;
    const ctx = ensureContext();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  devices?.addEventListener?.('devicechange', handleDeviceChange);
  docRef?.addEventListener?.('pointerdown', handlePointerDown);

  // Browsers create AudioContext suspended until a user gesture, and resume()
  // is async — a synchronous state check here would drop the unmute
  // confirmation and the first cue after it. Play immediately when running,
  // otherwise after resume() settles; skip cues that sat queued past 2s
  // (resume can hang until a qualifying gesture, and a "started" blip
  // arriving minutes late is just noise).
  function playWhenRunning(fn) {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'running') { fn(ctx); return; }
    const requestedAt = Date.now();
    ctx.resume().then(() => {
      if (ctx.state === 'running' && Date.now() - requestedAt < 2000) fn(ctx);
    }).catch(() => {});
  }

  // Howard found 0.06 too quiet on external speakers; 0.18 is ~3x the
  // amplitude (≈ +9.5 dB), still well below clipping for a single sine.
  function tone(ctx, { from, to, at, duration, peak = 0.18 }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + duration);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  // Start: short rising blip. Finish: two-note falling chime. Distinct shapes
  // so they're tellable apart without looking at the wall.
  function playStart() {
    playWhenRunning((ctx) => {
      tone(ctx, { from: 587, to: 880, at: ctx.currentTime, duration: 0.16 });
    });
  }

  function playFinish() {
    playWhenRunning((ctx) => {
      tone(ctx, { from: 880, to: 660, at: ctx.currentTime, duration: 0.14 });
      tone(ctx, { from: 660, to: 440, at: ctx.currentTime + 0.16, duration: 0.2 });
    });
  }

  function renderButton() {
    if (!button) return;
    const l = typeof labels === 'function' ? labels() : labels;
    const label = muted ? (l?.soundOff || 'Sounds muted') : (l?.soundOn || 'Sounds on');
    button.textContent = muted ? '🔕' : '🔔';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(!muted));
  }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem(STORAGE_KEY, String(muted)); } catch {}
    if (!muted) {
      // The toggle click is the user gesture that unlocks audio; confirm
      // audibly so "did that work?" never needs a second agent to answer.
      // playWhenRunning handles the suspended->running resume internally.
      playStart();
    }
    renderButton();
  }

  function handleFleet(fleet) {
    const { moods, started, finished } = computeFleetTransitions(prevMoods, fleet?.agents);
    prevMoods = moods;
    if (muted) return;
    if (started.length > 0) playStart();
    if (finished.length > 0) playFinish();
  }

  if (button) {
    button.addEventListener('click', toggle);
    renderButton();
  }

  return { handleFleet, toggle, isMuted: () => muted, refreshLabels: renderButton };
}
