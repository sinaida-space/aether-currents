# Case study: AETHER CURRENTS

**Live:** [aether-currents.sinaida.eu](https://aether-currents.sinaida.eu/)
**Concept and experience design:** Sinaida Krivchenko · [sinaida.eu](https://sinaida.eu)
**Music advisor:** Kamil Yegelev (TeleFM), Belgrade · [telefm.bandcamp.com](https://telefm.bandcamp.com/)
**Stack:** vanilla JS/CSS, ES modules, on-device hand tracking, granular synthesis, WebGL. No build step, no server, no accounts.

## Why

Every instrument worth playing can be practiced. That is the conviction AETHER CURRENTS is built on: an instrument you return to the way a dancer returns to the barre, until the interface disappears and only the playing remains.

Two things usually kill that in browser instruments, and both were design targets from day one: latency and musicality. When a hand moves and the sound answers 300 milliseconds later, nobody is playing an instrument; they are issuing requests to one. And when the pitch space is unquantized, every gesture becomes noise instead of music.

## How

Sinaida designed it as a single signal path. On-device hand tracking targets up to 60Hz and drives a granular synthesis engine directly:

```
RIGHT HAND x/y ... playhead position / pitch
RIGHT PINCH ...... grain size
LEFT HAND HEIGHT . grain density
TWO-HAND DISTANCE  filter + space
FIST ............. freeze the cloud
FAST OPEN PALM ... burst
```

Pitch is scale-quantized from the first note, currently to an A minor pentatonic across six bands, so gesture noise is designed to land inside the scale as an expressive note. The visual layer is driven by the same signal as the audio, so what you see is what you are playing.

The tool is built to keep camera frames and audio on the device, with no accounts. The privacy model was a design constraint from day one.

## What shipped, and what did not work at first

Version 3.2 removed file upload entirely, added a mic-review flow so a recording can be checked before it is kept, put BPM control directly in the UI, and added a two-hand gesture for chords and arpeggios. Each of those came from watching people actually try to play the thing and fail in a specific way. The interface should not need instructions, and every place it still does is a note for the next version.

Version 3.3, “PLAYABLE,” made the instrument sturdier. The visuals recover on their own after the GPU drops its context, and every recording keeps a backup capture, so a failed encoder no longer costs the take.

The latest version adds a second mode, GRID: on the beat, the hands write bars of 16 steps onto a tape kept in the browser, a pause opens a note editor, and the tape exports as a MIDI file.

## Why hands, and not a controller

The same question runs through Sinaida's work in ETHEREAL PATH, in STEREOLOVE and now here: what happens when the body itself becomes the input device. A MIDI controller asks you to learn its layout. A camera asks you to already know your own body, which you do, better than you know any hardware. The learning curve moves from fingers memorizing button positions to hands finding a gesture vocabulary that already lives in you.

The constraint is small on purpose. Six gestures, one scale, one engine. Inside that, each player finds their own range.

## Credits

concept and experience design by Sinaida Krivchenko · [sinaida.eu](https://sinaida.eu)  
music advisor: Kamil Yegelev (TeleFM) · [telefm.bandcamp.com](https://telefm.bandcamp.com/)
Built with on-device hand tracking, granular synthesis, WebGL.
