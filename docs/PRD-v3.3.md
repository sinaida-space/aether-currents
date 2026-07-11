# PRD: AETHER CURRENTS v3.3 — "PLAYABLE"

*Approved 2026-07-11. Planning: Fable. Implementation: Sonnet only.*

## Vision

Turn a beautiful instrument into a **reliable, fast** one: sub-100ms gesture
response, recordings that never fail silently, musicality from the beat grid.
The DJ-community values — easy, good sound, convenient — without losing the
conduct-with-hands identity.

## Findings from code recon (grounds the plan)

1. **Pitch is already scale-quantized** (A minor pentatonic, 6 bands,
   `js/mapping.js`). The "modulation isn't musical" complaint is a **timing**
   problem: 80ms pitch portamento (`TAU_PITCH`) + one-euro filter smoothing +
   40Hz tracking (`js/tracking/tracker.js` MODE_CONFIG) + audio param
   smoothing stack to ~150–300ms motion→sound lag.
2. **The "GPU bug" is specific**: the renderer (`js/visuals/renderer.js:53`)
   has no WebGL context-loss handling. A GPU reset on a weaker machine leaves
   the visuals permanently black. Only a boot-time probe exists
   (`js/syscheck.js`); nothing watches performance after boot.
3. **The recorder can wedge** (`js/recorder.js`): a VideoEncoder/AudioEncoder
   error mid-recording is only logged; `stop()` then throws on `flush()`, the
   button sticks on "● STOP", no file appears. FULL mode also records
   1080p60 H.264 on the main thread while rendering — recording stutter on
   pressured GPUs.

## Scope

- **In**: bug fixes (play/record), GPU resilience, latency overhaul, perf
  metrics overlay, scale/key system with UI on the pitch hand's side,
  beat-snapped notes.
- **Out (backlog)**: keyboard-arpeggio input (parked for later A/B), visual
  wow pass, MIDI, genre presets, YC pitch materials.

## Resolved Forks

- **Melody** = deepen scale quantization (scales / keys / beat-snap), no new
  input device — answers "more musical" at zero resource cost.
- **"GPU bulletproof"** = boot probe (exists) + runtime watchdog +
  context-loss recovery.
- **DJ's "resource re-evaluation"** = PERF overlay with real numbers first,
  then a show/hide UI panel — measure before cutting.
- **Models** = Fable plans and writes specs; Sonnet implements everything.
  The two DSP-heavy tasks (5, 7) get specs that pre-resolve all judgment
  calls (time constants, snap-commit algorithm) so Sonnet-high suffices.

## Task Breakdown

| # | Task | Model | Effort | Est. | Depends on |
|---|------|-------|--------|------|-----------|
| 1 | Instrumentation + error surfacing — `?debug` PERF overlay (render/tracking FPS, motion→sound latency, encoder queue); record errors shown in HUD, never silent | sonnet | med | ~15k | — |
| 2 | WebGL context-loss recovery — rebuild pipeline on `contextrestored`, HUD notice; repeated loss → offer LIGHT | sonnet | high | ~20k | 1 |
| 3 | Recorder hardening — encoder error → graceful stop + fallback; un-wedgeable button state machine; marginal machines record 1080p30 instead of 1080p60 | sonnet | high | ~20k | 1 |
| 4 | Runtime perf watchdog — FULL mode under ~45fps in first 15s → toast "switch to LIGHT?" | sonnet | med | ~10k | 1 |
| 5 | Latency cut — snap-fast pitch on band change / glide within band, tuned one-euro cutoffs, explicit `latencyHint:'interactive'`, tracking 40→60Hz if headroom. Target: **measured < 100ms**. Spec pre-resolves all DSP constants | sonnet | high | ~30k | 1 |
| 6 | Scale & key system + UI — 4 scales (min pentatonic / blues / maj pentatonic / nat minor), root key select, scale ladder on the RIGHT edge (pitch hand's side) with live note names | sonnet | med | ~18k | — |
| 7 | Beat-snap mode — when BEAT is on, note changes commit on the next 8th note. Spec pre-resolves the snap-commit algorithm | sonnet | high | ~25k | 5, 6 |
| 8 | UI declutter panel — show/hide rows per UI element, "MINIMAL" view | sonnet | low | ~8k | 6 |

**Total ≈ 146k tokens, all sonnet-tier** (estimate, not a guarantee).

## Success Criteria

1. Record → stop → export: 10/10 on the dev Mac (Chrome); a forced encoder
   failure surfaces an error in the HUD and recovers — never wedges.
2. `?debug` overlay shows motion→sound **< 100ms** in FULL mode.
3. DevTools-forced context loss → visuals recover, audio never stops.
4. **The DJ friend test**: beat on, snap on — he calls it usable. His word is
   the metric.

## GitHub Plan

- Feature branch `v3.3`; merge to main only when success criteria pass (the
  site is live and public on GitHub Pages).
- One issue per task, full spec in the issue body before dispatch.

## Execution Mode

- **Planning/specs**: Fable (orchestrator session) writes every issue spec to
  "implementer never opens a file for research" depth.
- **Implementation**: Sonnet developer agents. Tight budget → Chamber shape:
  ~3 dispatch groups by dependency — (1, 6) → (2, 3, 4) → (5, 7, 8) —
  verification batched per group.
- Escalation if an agent fails twice: flag to Sinaida before anything more
  expensive. Never silent Opus.
- Recommended order: 1 → 3 → 2 → 4 → 5 → 6 → 7 → 8. Tasks 1+3 alone likely
  kill the bugs users are hitting.

## YC note

The tech story (browser instrument, zero install, on-device tracking) is
strong, but YC funds **traction**: after v3.3, the move is 10 real
DJs/dancers using it and sharing recordings. The DJ friend is user #1 of
that loop.
