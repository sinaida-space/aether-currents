// perf-bus.js — tiny synchronous event bus for performance telemetry.
//
// mapping.js and main.js publish into this; today only perf-recorder.js
// subscribes (to build a Standard MIDI File export), but the bus itself
// knows nothing about MIDI — it's the seed for the backlog "Ableton/OSC/
// Link bridge" item (issue tracking v3.4), which will subscribe the same
// way to stream live CC/Note out over a WebSocket instead of (or alongside)
// recording to a .mid file.
//
// Event shapes (informal contract, not enforced):
//   perfBus.emit('cc', { param, value })         — continuous gesture param
//   perfBus.emit('kick', { tSec })                — beat scheduler kick
//   perfBus.emit('hat', { tSec })                 — beat scheduler hi-hat
//   perfBus.emit('sampleSwitch', { id, on })       — sample layer toggled
//   perfBus.emit('sampleMute', { id, muted })      — timeline lane mute toggle

class PerfBus {
  constructor() {
    this._subs = new Map(); // type -> Set<fn>
  }

  on(type, fn) {
    if (!this._subs.has(type)) this._subs.set(type, new Set());
    this._subs.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const set = this._subs.get(type);
    if (set) set.delete(fn);
  }

  emit(type, data) {
    const set = this._subs.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[perf-bus] subscriber for "${type}" threw`, err);
      }
    }
  }
}

// Singleton — every module imports the same bus instance.
export const perfBus = new PerfBus();
