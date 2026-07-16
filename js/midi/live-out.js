// live-out.js — live Web MIDI output bridge. Subscribes to perfBus and
// streams the same CC/note scheme perf-recorder.js writes into .mid files
// (see cc-map.js), so a recorded performance and the live stream are always
// interchangeable — one documented mapping, no divergence.
//
// navigator.requestMIDIAccess is only ever called from connect()/listPorts(),
// which callers must only invoke on first user interaction with the MIDI
// panel — never on page load, to avoid an unprompted permission dialog.

import { perfBus } from './perf-bus.js';
import { CC_MAP, normalizeCC, CC_THROTTLE_MS } from './cc-map.js';

const NOTE_OFF_MS = 50;

export class MidiLiveOut {
  constructor() {
    this._access = null;
    this._port = null;
    this._unsubs = [];
    this._lastCcMs = {};
    this._lastCcValue = {};
    // { offBytes, dueAt } records for note-offs scheduled on the port's own
    // clock (see _sendWithOff) — not setTimeout ids. Used so disconnect()
    // can flush any not-yet-fired note-offs before the port is dropped.
    this._pendingOffs = new Set();
  }

  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  }

  get active() {
    return this._port;
  }

  // Lazily requests MIDI access (only on first call) and returns the list of
  // available output ports as [{ id, name }].
  async listPorts() {
    if (!this.supported) return [];
    if (!this._access) {
      try {
        this._access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[live-out] requestMIDIAccess failed:', err);
        return [];
      }
    }
    return Array.from(this._access.outputs.values()).map((p) => ({ id: p.id, name: p.name }));
  }

  async connect(portId) {
    if (!this.supported) return false;
    if (!this._access) {
      try {
        this._access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[live-out] requestMIDIAccess failed:', err);
        return false;
      }
    }
    const port = this._access.outputs.get(portId);
    if (!port) return false;

    this.disconnect();
    this._port = port;
    this._access.onstatechange = (e) => {
      if (e.port && e.port.id === this._port?.id && e.port.state === 'disconnected') {
        this.disconnect();
        if (this.onDisconnect) this.onDisconnect();
      }
    };
    this._subscribe();
    return true;
  }

  disconnect() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    // Flush any note-offs that haven't fired yet, while the port reference
    // is still valid — otherwise switching ports (or OFF) inside the
    // note-off window leaves a stuck note on the synth/DAW.
    if (this._port) {
      for (const record of this._pendingOffs) {
        try {
          this._port.send(record.offBytes);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[live-out] failed to flush pending note-off:', err);
        }
      }
    }
    this._pendingOffs.clear();
    this._lastCcMs = {};
    this._lastCcValue = {};
    this._port = null;
  }

  _send(bytes) {
    if (!this._port) return;
    this._port.send(bytes);
  }

  // Sends the note-on immediately and schedules the note-off via the Web
  // MIDI port's own clock (a DOMHighResTimeStamp on the same timeline as
  // performance.now()) rather than setTimeout. Timer-based scheduling gets
  // throttled when the tab is backgrounded (observed ~730ms late instead of
  // ~50ms), causing stuck notes — port.send(bytes, timestamp) is handled by
  // the browser's MIDI scheduler and isn't subject to that throttling.
  // We still track pending offs (not for delivery, just so disconnect() can
  // flush anything not yet fired, and so this bookkeeping set doesn't leak).
  _sendWithOff(onBytes, offBytes) {
    if (!this._port) return;
    this._send(onBytes);
    const dueAt = performance.now() + NOTE_OFF_MS;
    this._port.send(offBytes, dueAt);
    const record = { offBytes, dueAt };
    this._pendingOffs.add(record);
    setTimeout(() => this._pendingOffs.delete(record), NOTE_OFF_MS);
  }

  _subscribe() {
    const onCc = ({ param, value }) => {
      const cc = CC_MAP[param];
      if (cc === undefined) return;
      const nowMs = performance.now();
      const last = this._lastCcMs[param];
      if (last !== undefined && nowMs - last < CC_THROTTLE_MS) return;
      const norm = normalizeCC(param, value);
      if (this._lastCcValue[param] === norm) return; // skip unchanged
      this._lastCcMs[param] = nowMs;
      this._lastCcValue[param] = norm;
      this._send([0xb0, cc, norm]); // channel 1 (status nibble 0xB0)
    };

    const onKick = () => this._sendWithOff([0x99, 36, 100], [0x89, 36, 0]); // ch10 idx9, matches perf-recorder.js
    const onHat = () => this._sendWithOff([0x99, 42, 90], [0x89, 42, 0]); // ch10 idx9, matches perf-recorder.js

    const onSampleSwitch = ({ laneIndex, on }) => {
      if (laneIndex == null) return;
      const note = (on ? 60 : 72) + Math.max(0, Math.min(3, laneIndex));
      this._sendWithOff([0x91, note, 100], [0x81, note, 0]); // ch2 idx1
    };
    const onSampleMute = ({ laneIndex, muted }) => {
      if (laneIndex == null) return;
      const note = (muted ? 84 : 96) + Math.max(0, Math.min(3, laneIndex));
      this._sendWithOff([0x91, note, 100], [0x81, note, 0]); // ch2 idx1
    };

    this._unsubs = [
      perfBus.on('cc', onCc),
      perfBus.on('kick', onKick),
      perfBus.on('hat', onHat),
      perfBus.on('sampleSwitch', onSampleSwitch),
      perfBus.on('sampleMute', onSampleMute),
    ];
  }
}
