# Case Study: Aether Currents

**Live:** [aether-currents.sinaida.eu](https://aether-currents.sinaida.eu/)
**Collaborator:** Kamil Yegelev (Telefm, Belgrade) — [telefm.bandcamp.com](https://telefm.bandcamp.com/)
**Stack:** vanilla JS/CSS, ES modules, on-device hand tracking, granular synthesis, WebGL. No build step, no server, no accounts.

## Why

Every instrument worth playing can be practiced. That is the conviction Aether Currents is built on: not a demo you try once, but an instrument you return to the way a dancer returns to the barre — until the interface disappears and only the playing remains.

Two things usually kill that in browser instruments, and both were design targets from day one: latency and musicality. When a hand moves and the sound answers 300 milliseconds later, nobody is playing an instrument; they are issuing requests to one. And when the pitch space is unquantized, every gesture becomes noise instead of music.

## How

Sinaida engineered it as a single signal path. On-device hand tracking reads gesture at up to 40Hz and drives a granular synthesis engine directly:

```
RIGHT HAND x/y ... playhead position / pitch
RIGHT PINCH ...... grain size
LEFT HAND HEIGHT . grain density
TWO-HAND DISTANCE  filter + space
FIST ............. freeze the cloud
FAST OPEN PALM ... burst
```

Pitch is scale-quantized from the first note — currently an A minor pentatonic across six bands — so gesture noise can never produce a wrong note, only an expressive one. The visual layer is not a separate output: it is driven by the same signal as the audio, so what you see is what you are playing, not an illustration of it.

Nothing leaves the device. No camera frame, no audio, no account. The privacy model was a design constraint from day one, not a policy added at the end.

## What shipped, and what did not work at first

Version 3.2 removed file upload entirely, added a mic-review flow so a recording can be checked before it is kept, put BPM control directly in the UI, and added a two-hand gesture for chords and arpeggios. Each of those came from watching people actually try to play the thing and fail in a specific way. The interface should not need instructions, and every place it still does is a note for the next version.

The current cycle, documented in PRD v3.3 "PLAYABLE," targets performance and experience optimization. A GPU context loss should not turn the screen permanently black. A recording should never silently fail and leave a stuck button with no file to show for it. And the motion-to-sound gap — measured, not guessed — needs to come under 100 milliseconds. None of this is visible when it works. All of it is instantly visible when it does not. That asymmetry is the whole difficulty of building something meant to feel like an instrument instead of a piece of software.

## Why hands, and not a controller

The same question runs through Sinaida's work — in Ethereal Path, in Stereolove, and now here: what happens when the body itself becomes the input device. A MIDI controller asks you to learn its layout. A camera asks you to already know your own body, which you do, better than you know any hardware. The learning curve is not gone; it moves from fingers memorizing button positions to hands finding a gesture vocabulary that already lives in you.

The constraint is small on purpose. Six gestures, one scale, one engine. Inside that, the range of what someone can play is not something the designer decided — it is something each player finds.

## Credits

Instrument and code: Sinaida Krivchenko · [sinaida.eu](https://sinaida.eu)
Music and collaboration: Kamil Yegelev as Telefm
Built with on-device hand tracking, granular synthesis, WebGL.
