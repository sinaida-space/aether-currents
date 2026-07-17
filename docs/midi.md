# Live MIDI Out

> **Chromium only.** Live MIDI out requires the [Web MIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API)
> (`navigator.requestMIDIAccess`), which Chrome, Edge, Brave, Opera, and
> Firefox 108+ support — **Safari (macOS and iOS) does not implement it at
> all**, with no toggle to enable it. This is a WebKit limitation, not
> something fixable from the app. The `▸ MIDI` button is hidden automatically
> on unsupported browsers. Safari users can still get every gesture/beat
> event as a `.mid` file via `▸ SAVE MIDI` after a recording — see below.

Aether Currents can stream gesture and beat events as real-time MIDI to any
Web MIDI output port, turning the instrument into a live controller for a
DAW (Ableton, TouchDesigner, hardware synths/drum racks). Open the panel
with the `▸ MIDI` button in the control row (or the `M` key), pick an output
port, and play — every gesture and beat event streams out immediately.

No OSC, no WebSocket bridge, no MIDI input, no Ableton Link. Output only,
one direction, one scheme.

The same mapping also drives the offline `.mid` export (`▸ SAVE MIDI` after
a recording) — a recorded file and the live stream are always
interchangeable, byte-for-byte identical CC numbers and note numbers.

## CC / note map

Channel 1, fixed CC numbers 20+:

| CC  | Param         | Range (raw)  | Notes                                   |
|-----|---------------|--------------|------------------------------------------|
| 20  | position      | 0..1         | playhead position                        |
| 21  | pitch         | 0.25..4x     | linearly rescaled to 0..127               |
| 22  | grainSize     | 0..1         | grain size                                |
| 23  | density       | 4..60        | grain density                             |
| 24  | filterCutoff  | 0..1         | filter cutoff                             |
| 25  | reverbMix     | 0..1         | reverb mix                                |
| 26  | chord         | 0/1          | chord mode on/off                         |

CC values are throttled to ~30Hz per parameter and skipped when unchanged,
so a static hand position doesn't flood the port.

Discrete events:

| Channel | Event                        | Note                                    |
|---------|-------------------------------|------------------------------------------|
| 10      | beat kick                     | note-on 36 (GM kick), velocity 100       |
| 10      | beat hi-hat                   | note-on 42 (GM closed hat), velocity 100 |
| 2       | sample switched on            | note-on 60 + laneIndex                   |
| 2       | sample switched off           | note-on 72 + laneIndex                   |
| 2       | sample lane muted              | note-on 84 + laneIndex                   |
| 2       | sample lane unmuted            | note-on 96 + laneIndex                   |

Every note-on is followed by a matching note-off ~50ms later — the live
bridge always sends complete note pairs, never a hanging note.

Beat notes (36/42) land directly on a General MIDI drum rack — no mapping
needed in most DAWs.

## Setup

### macOS — IAC Driver (no extra software)

1. Open **Audio MIDI Setup** (Spotlight → "Audio MIDI Setup").
2. **Window → Show MIDI Studio**.
3. Double-click the **IAC Driver** icon.
4. Check **"Device is online"**. Leave the default "Bus 1" port, or add one.
5. In Aether Currents, open `▸ MIDI` and select the IAC bus.

### Windows — loopMIDI

macOS ships a virtual MIDI bus; Windows doesn't. Install
[loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) (free),
create a port, then select it from the `▸ MIDI` panel the same way.

### Ableton Live

1. Enable the IAC bus (or loopMIDI port) as a MIDI input in
   **Live → Preferences → Link/MIDI**: turn on **Track** and **Remote** for
   that port's input.
2. For gesture CCs: right-click a device parameter → **MIDI-map**, then move
   the corresponding gesture (e.g. right-hand X for CC20/position). Repeat
   for CCs 21–26.
3. For beat notes: create a MIDI track routed from the same port, load a
   **Drum Rack** on channel 10 — kick lands on pad 36, hat on pad 42.
4. Sample switch/mute notes (channel 2, notes 60–103) can trigger clips or
   drum rack pads the same way if you want lane changes to fire something.

### TouchDesigner

Add a **MIDI In CHOP**, set its **Driver** to the IAC bus / loopMIDI port.
CC channels appear as `ch1cc20`…`ch1cc26`; note events appear as
`ch10note36`, `ch10note42`, etc. — feed those directly into your own
patches.

### Verify without a DAW

Install a MIDI monitor (e.g. [MIDI Monitor](https://www.snoize.com/midimonitor/)
on macOS, or `MIDI-OX` on Windows), point it at the IAC/loopMIDI port
selected in Aether Currents, and move your hands — CC and note messages
should appear in real time with the values described above.
