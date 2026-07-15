# Sound Research — a gesture-native sonic language

Kraftwerk's revolution was removing the body: machines became the band, "Die Mensch-Maschine" a deliberate erasure of performative gesture in favor of the panel and the sequencer. The inverse move is unclaimed. Feed the involuntary body into the machine instead of subtracting it. Tremor, fatigue, asymmetry, the impossibility of holding a hand perfectly still in open air — everything a keyboard, a grid, or a knob is engineered to filter out becomes the material rather than the noise floor. A continuous two-hand camera interface, tracking twenty-one landmarks per hand at frame rate with no mechanical detent to lean on, is the first mass-available instrument that can keep this signal instead of discretizing it away. The five directions below treat that fact as the design brief.

## Prior art in brief

The theremin proved continuous, contactless, two-axis control is playable, but its own literature names the cost directly: pitch accuracy depends on "proprioceptive memory of hand position in open air, with no physical detent or fret" ([Britannica](https://www.britannica.com/art/theremin)). Every instrument surveyed since has tried to buy back that missing reference — gloves added tactile switches and bend sensors (Sonami's Lady's Glove: "2 ultrasound sensors, 3 accelerometers, 7 bend/resistive strips, 1 pressure pad, 9 micro-switches, 5 Hall-effect sensors" — [sonami.net](https://sonami.net/portfolio/items/ladys-glove/)), Mi.Mu gloves added IMUs and flex sensors routed to MIDI/OSC ([Synergy FM](https://synergyfm.net/gesture-music-a-detailed-analysis-of-mi-mu-gloves/)), and Waisvisz's "The Hands" grew from 39 to 88 discrete sensors across sixteen years of iteration ([MIT Press](https://direct.mit.edu/comj/article/40/2/22/94545/The-Hands-The-Making-of-a-Digital-Musical)). All of it converges on the same move: more channels, still discretized, still one-to-one or hand-patched many-to-many.

Two documented failures matter more than the successes here. Atau Tanaka's BioMuse work hit a protocol mismatch he stated outright: "the source biodata is a rich, continuous signal that is constantly changing, while MIDI is an event-based music control specification" ([eContact!](https://econtact.ca/14_2/tanaka_personalsurvey.html)) — continuous body signal forced through a discrete event pipe. Pamela Z's BodySynth went further: her own account of a "disaster" first outing describes elevated adrenaline causing involuntary EMG spikes that triggered samples "higgledy-piggledy," resolved only by learning to "be really still in your body" ([eContact! interview](https://econtact.ca/10_2/ZPamela_KD.html)). In both cases the involuntary body was treated as corruption to be suppressed, never as compositional material. That is the gap this research occupies.

Camera-based systems get closer to the current instrument's territory but stop short of it. Geco MIDI treats Leap Motion tracking purely as a MIDI CC generator, explicit that it "doesn't produce or manipulate sound directly" ([uwyn.com/geco](https://uwyn.com/geco/)). GestureGroove runs MediaPipe-style tracking to Tone.js oscillator synths, one-to-one per axis, and states its own ceiling: "currently limited to simple linear scales without polyphonic chord mapping" ([bionichaos.com](https://bionichaos.com/GestureGroove/)). Handmate positions itself explicitly as "a controller layer, not a sound source" across three MIDI/OSC/effects modes ([monicalim.online/handmate](https://www.monicalim.online/handmate)). None of the located prior art pairs browser MediaPipe hand-tracking with granular synthesis — the survey found no such system. The field's own stated open problems (repeatability as "a key factor in evaluating digital musical instruments," an audience-legibility finding that "a lack of perceptible causality has a negative impact on ratings of DMI performances," and the discrete/continuous mismatch above) ([Springer](https://link.springer.com/chapter/10.1007/978-3-319-07668-3_62), [ResearchGate](https://www.researchgate.net/publication/316614469_Gesture-Sound_Causality_From_the_Audience's_Perspective_Investigating_the_Aesthetic_Experience_of_Performances_With_Digital_Musical_Instruments)) frame what a gesture-native language would need to answer, not just avoid.

## The five directions

### 1. The Medium

**Concept.** Hands do not play the synth directly; they stir a simulated 2D field, and the field itself is sonified. Push into it and a vortex spins up, drags neighboring cells, and decays on its own clock, independent of whether the hand is still moving. The granular cloud becomes the excitation voice for that field — grain density, position, and spectral content driven by local field velocity and vorticity rather than by raw hand coordinates. The performer stops being a controller of parameters and becomes a disturbance in a medium that has its own inertia. This literalizes the instrument's own name: Aether Currents becomes an instrument about currents, not a metaphor borrowed for branding.

**Why gesture-native.** No control surface can be "stirred." A knob or fader is a scalar; the field state at any moment is a 2D vector grid with history — turbulence that outlives the gesture that caused it. The mapping is gesture → simulated physics → sound, one level of indirection past anything a discrete or even continuous controller offers, because the intermediate physical state has no direct manual equivalent to grab.

**Vs prior art.** Every system surveyed maps gesture straight to sound parameter: theremin (distance → pitch), Geco (Leap tracking → MIDI CC), GestureGroove (hand position → pitch/volume axes) ([bionichaos.com](https://bionichaos.com/GestureGroove/)). None interpose a persistent, decaying medium between hand and synthesis engine. It also directly answers the audience-legibility gap the field names: a visible fluid field gives the audience the same causal object the performer is manipulating — they see the wake they hear, rather than inferring an invisible mapping from hand motion alone ([ResearchGate](https://www.researchgate.net/publication/316614469_Gesture-Sound_Causality_From_the_Audience's_Perspective_Investigating_the_Aesthetic_Experience_of_Performances_With_Digital_Musical_Instruments)).

**Build sketch.** A coarse CPU grid (roughly 32×24, stable-fluids or spring-mass) updated once per rAF tick alongside the existing gesture read in `js/mapping.js`. Hand landmark velocity injects force/dye into nearby cells; the grid steps forward each frame at negligible cost relative to MediaPipe inference. Cell velocity magnitude and vorticity at sampled points feed the existing granular worklet (`js/audio/granular-worklet.js`) as excitation parameters — grain density and position modulation — smoothed through the existing `setTargetAtTime` pattern already used for gesture params. The granular engine is not replaced; it becomes the voice the field excites. Visual layer renders the field directly (the same simulation state driving audio also drives the on-screen wake), closing the causality loop for the audience.

### 2. Chirospectral Synthesis

**Concept.** The hand's shape — splay, curl, and arch per finger, derived from the 21 MediaPipe landmarks — is read directly as a spectral envelope: a continuous roughly 21-dimensional vector standing in for a bank of partial gains or filter-band levels. Opening a fist is not a gesture that triggers a timbre change; it is the timbre changing, continuously, because the shape and the spectrum are the same value read two ways. A hand curling into a claw produces the same sonic gesture whether it happens in 40ms or four seconds.

**Why gesture-native.** No fader bank can be operated as one continuous shape with proprioceptive unity — a performer moving 21 physical faders in a coordinated arc has coordination noise a hand does not, because the hand's joints are mechanically linked (tendons cross multiple joints) in a way faders never are. The instrument exploits an anatomical fact no controller replicates: your fingers already move as a partially-coupled system, and that coupling becomes free correlation structure in the spectrum instead of something to fight.

**Vs prior art.** Sonami's and Waisvisz's gloves had a handful of discrete sensor channels (bend strips, potentiometers) mapped to a handful of parameters via custom patches — not a continuous shape-to-spectrum identity, and each channel was independently wired rather than treated as one coupled vector ([sonami.net](https://sonami.net/portfolio/items/ladys-glove/), [MIT Press](https://direct.mit.edu/comj/article/40/2/22/94545/The-Hands-The-Making-of-a-Digital-Musical)). Leap-based tools like Geco map hand position and gross gesture to MIDI CC, not per-finger shape to a full spectral vector ([uwyn.com/geco](https://uwyn.com/geco/)). This also sidesteps GestureGroove's stated ceiling of "simple linear scales without polyphonic chord mapping" ([bionichaos.com](https://bionichaos.com/GestureGroove/)) by moving the expressive dimension from pitch selection to timbre, where a 21-band continuous space has no discrete-chord equivalent to fall short of.

**Build sketch.** Per-frame, compute a splay/curl/arch value per finger from adjacent landmark angles (already available from the existing MediaPipe landmark stream powering `js/mapping.js`). Map the resulting vector to a bank of biquad filters or additive partial gain multipliers inside the granular worklet, one coefficient set derived per grain window. Smoothing follows the existing per-parameter `setTargetAtTime` epsilon-gated write pattern (`EPS`, `TAU` constants already defined in `js/mapping.js`) to avoid flooding the audio thread's param queue at 60fps.

### 3. Tremor Engine

**Concept.** High-pass the landmark position stream itself. What is normally discarded as tracking jitter — the involuntary micro-oscillation of a hand held in place — becomes the modulation source: grain jitter, amplitude tremor, a subtle pitch flutter. A slower band of the same stream, the drift that accumulates as a held pose fatigues over tens of seconds, becomes a macro-structural parameter: the piece's filter opening or spatial width widens as the arm tires. A sustained note is alive specifically because a human hand cannot be held perfectly still, and the composition's form is literally the shape of that fatigue over a performance's duration.

**Why gesture-native.** This is not simulated or metaphorical noise; it is the performer's own involuntary physiology, unrepeatable by design and impossible to produce on any mechanical controller, which resists and dampens exactly this kind of micro-motion by construction (springs, detents, and rest positions exist to suppress it).

**Vs prior art.** Pamela Z's BodySynth treated an analogous signal — involuntary EMG activity under adrenaline — as pure corruption, something to be eliminated by the performer learning stillness ([eContact! interview](https://econtact.ca/10_2/ZPamela_KD.html)). Tanaka's stated frustration with continuous biosignals against event-based MIDI ([eContact!](https://econtact.ca/14_2/tanaka_personalsurvey.html)) names the same category of signal as a problem to route around. This direction inverts both: the involuntary signal is not routed around, filtered out, or apologized for — it is the entire premise, and no source in the survey stages the involuntary body as the design target rather than the design defect.

**Build sketch.** Cheapest of the five to prototype. Per-landmark high-pass/band-split of the tracking coordinate history (a simple two-pole filter per axis, run on the main thread alongside the existing gesture read — negligible cost against MediaPipe inference). Fast band (tremor, roughly 4–12Hz) drives grain jitter/AM depth in the worklet; slow band (drift over 10s+ windows) drives a macro parameter such as filter cutoff or reverb mix, already exposed as gesture-mapped params in `js/mapping.js`. No new tracking infrastructure required — this reads the same landmark stream the instrument already has, just at a frequency band currently thrown away by the smoothing time constants (`TAU`, `TAU_POSITION`).

### 4. Gesture Canon

**Concept.** The instrument records not audio but gesture trajectories — the same control-parameter stream already captured for MIDI export — and replays them later as ghost hands moving through the current, now-different synthesis state. A phrase played a minute ago returns, but the filter has drifted, the field (if Direction 1 is present) has different turbulence, the scale may have changed — canon with a past self that is structurally guaranteed never to sound twice identical, because the replayed intention meets conditions it did not originate in.

**Why gesture-native.** A looper repeats captured audio, a fixed waveform played back unchanged. This repeats intention — the control signal, not the result — through a synthesis state that has moved on. A MIDI-controller looper could technically record CC data too, but nothing about that architecture is native to hands; here the ghost hands are rendered visually in the same space as the live hands, so the canon is legible as a body duetting with its own recent past, not an abstract automation lane.

**Vs prior art.** This directly answers the field's stated repeatability gap — NIME literature names "repeatability — the ability to reproduce sounds with intention" as a documented weak point of digital musical instruments generally ([NIME 2020](https://www.nime.org/proceedings/2020/nime2020_paper41.pdf)). Rather than engineering repeatability as fidelity (make the same gesture sound the same twice), this direction makes non-repeatability itself the compositional device, sidestepping the problem instead of solving it head-on.

**Build sketch.** The perf-bus/perf-recorder infrastructure already exists (`js/midi/perf-recorder.js`, `js/midi/perf-bus.js`) and already logs gesture-derived CC-equivalent parameter streams (position, pitch, grainSize, density, filterCutoff, reverbMix, chord) at up to 30Hz, currently exported as a Standard MIDI File. Ghost playback replays a captured buffer of these events back through `js/mapping.js` as a second, non-visually-tracked voice feeding the same engine, running concurrently with the live gesture stream. Ghost hand positions (already present in the recorded stream as position data) render through the existing visual layer at reduced opacity or a distinct hue, giving the audience a legible second performer.

### 5. Relational Interferometry

**Concept.** Parameters are driven not by either hand's absolute position but by the relation between the two hands: their distance, their angle, and a symmetry-error term measuring how far the two hands deviate from mirroring each other. Two granular voices detune or phase-offset against each other proportionally to that relational state, producing beating and interference patterns that shift as the performer's bimanual coordination tightens or loosens. Precision here is not "hit the right spot" but "hold two things in a matched relation," a fundamentally different and harder motor task.

**Why gesture-native.** Relational continuous control — one output driven by the live geometric relationship between two independent, freely moving points — has no discrete-controller equivalent. Two knobs under two hands can each be set precisely, but nothing about a knob measures the relationship between them; that measurement itself requires a sensing layer neither knob has, which is exactly what camera-based two-hand tracking provides for free.

**Vs prior art.** The theremin is the closest antecedent and is explicitly absolute, one-hand-per-parameter, with no relational term between the two independent antennae ([SensorWiki](https://sensorwiki.org/instruments/theremin)). Hunt, Wanderley & Kirk's mapping research argues acoustic instruments already rely on this kind of complexity — a violin has "no single volume control" but a simultaneous combination of bow-speed, bow-pressure, string choice and finger position — and that many-to-many mappings are needed to "maximise human performance possibilities in expert manipulation situations" ([ResearchGate](https://www.researchgate.net/publication/209436163_Towards_a_Model_for_Instrumental_Mapping_in_Expert_Musical_Interaction)); relational two-hand mapping is a direct, sourced application of that finding no surveyed instrument implements. It also gives the audience a second, purely physical legibility channel beyond sound: visible bimanual tension between two hands straining toward or away from symmetry, addressing the same audience-causality gap named above through the body itself rather than through visualization.

**Build sketch.** Distance, angle, and a mirror-symmetry error metric (comparing the two tracked hands' landmark sets after reflecting one across the frame's vertical axis) are all derivable directly from the two-hand landmark data the tracker already produces every frame — no new sensing. These three scalars drive detune amount and phase offset between two granular voices already running in the worklet, using the existing smoothing infrastructure in `js/mapping.js`. Lowest new-DSP burden of the five: it is a mapping-layer change over existing two-voice capability, not a new synthesis technique.

## Scoring

| Concept | Irreproducibility | Differentiation | Buildability | Notes |
|---|---|---|---|---|
| 1. The Medium | ✦✦✦ | ✦✦✦ | ✦ | Strongest conceptual claim (no surveyed system interposes simulated physics); also the most new code — a stable field sim at 60fps alongside MediaPipe inference is the tightest performance budget of the five. |
| 2. Chirospectral Synthesis | ✦✦ | ✦✦✦ | ✦✦ | No prior-art system reads shape-as-spectrum continuously; moderate build cost (a filter bank keyed to a derived vector), but per-finger angle math needs care to stay stable frame-to-frame. |
| 3. Tremor Engine | ✦✦✦ | ✦✦✦ | ✦✦✦ | The clearest inversion of a *documented failure* (BodySynth, Tanaka) into a design target; cheapest build — reuses the existing landmark stream at a currently-discarded frequency band. |
| 4. Gesture Canon | ✦✦ | ✦✦ | ✦✦✦ | Directly answers the field's named repeatability gap; nearly all required infrastructure (perf-bus recording) already exists and only needs a playback path. |
| 5. Relational Interferometry | ✦✦ | ✦✦ | ✦✦✦ | Grounded in a specific research claim (Hunt/Wanderley on many-to-many mapping) rather than a failure case; lowest new-DSP burden — a mapping-layer change over the existing two-voice engine. |

No winner is declared here; the ranking above scores strength and cost on separate axes deliberately so the final choice of direction remains the artist's.

## Sources

- [Wikipedia — Theremin](https://en.wikipedia.org/wiki/Theremin)
- [SensorWiki — Theremin](https://sensorwiki.org/instruments/theremin)
- [Physics Today — the science of the theremin](https://physicstoday.aip.org/news/playing-with-electromagnetic-waves-the-science-of-the-theremin)
- [Britannica — Theremin](https://www.britannica.com/art/theremin)
- [SoundOnSound — Ondes Martenot](https://www.soundonsound.com/reviews/soniccouture-ondes)
- [Instructables — The Ondestrak](https://www.instructables.com/The-Ondestrak/)
- [MIT Press / Computer Music Journal — The Hands](https://direct.mit.edu/comj/article/40/2/22/94545/The-Hands-The-Making-of-a-Digital-Musical)
- [ResearchGate — Physical Intentions: Michel Waisvisz's The Hands](https://www.researchgate.net/publication/321287534_Physical_Intentions_Exploring_Michel_Waisvisz's_The_Hands_Movement_1)
- [sonami.net — Lady's Glove](https://sonami.net/portfolio/items/ladys-glove/)
- [Media Art Net — Lady's Glove](http://www.medienkunstnetz.de/works/ladys-glove/)
- [Synergy FM — Mi.Mu Gloves](https://synergyfm.net/gesture-music-a-detailed-analysis-of-mi-mu-gloves/)
- [Wikipedia — Mi.Mu Gloves](https://en.wikipedia.org/wiki/Mi.Mu_Gloves)
- [New Atlas — Beatjazz](https://newatlas.com/beatjazz-hands-gestural-digital-musical-interface/21744/)
- [Engadget — Onyx Ashanti Beatjazz](https://www.engadget.com/2012/08/02/onyx-ashanti-beatjazz-controller/)
- [Evil Twin Booking — Onyx Ashanti](https://eviltwinbooking.org/speakers/onyx-ashanti/)
- [CDM — Onyx Ashanti Beatjazz](https://cdm.link/2012/11/way-out-from-behind-the-laptop-onyx-ashantis-beatjazz-augmented-body-keeps-mutating/)
- [eContact! — Atau Tanaka personal survey](https://econtact.ca/14_2/tanaka_personalsurvey.html)
- [pamelaz.com — BodySynth](http://www.pamelaz.com/bodysynth.html)
- [eContact! — Pamela Z interview](https://econtact.ca/10_2/ZPamela_KD.html)
- [uwyn.com — Geco MIDI](https://uwyn.com/geco/)
- [Synthtopia — Geco MIDI expressive performance](https://www.synthtopia.com/content/2018/01/04/expressive-performance-with-geco-midi-leap-motion-controller/)
- [VI-Control — Geco/Leap Motion support thread](https://vi-control.net/community/threads/does-geco-work-with-leap-motion-anymore.112481/)
- [bionichaos.com — GestureGroove](https://bionichaos.com/GestureGroove/)
- [NIME pubpub — Handmate](https://nime.pubpub.org/pub/omb6e716)
- [MIT Press CMJ — Handmate: An Accessible Browser-Based Gestural Controller](https://direct.mit.edu/comj/article/47/3/6/125444/An-Accessible-Browser-Based-Gestural-Controller)
- [monicalim.online — Handmate](https://www.monicalim.online/handmate)
- [GitHub — webcam-theremin](https://github.com/eoinfennessy/webcam-theremin)
- [GitHub — soundgo](https://github.com/Gojaehyeon/soundgo)
- [Bristol+Bath Creative R&D — mediapipe2osc](https://bristolbathcreative.org/article/mediapipe-to-osc-camera-based-motion-tracking-for-expanded-performance)
- [ResearchGate — Hunt/Wanderley/Kirk, Towards a Model for Instrumental Mapping](https://www.researchgate.net/publication/209436163_Towards_a_Model_for_Instrumental_Mapping_in_Expert_Musical_Interaction)
- [IRCAM — Hunt, Towards a Model for Instrumental Mapping (PDF)](http://recherche.ircam.fr/anasyn/wanderle/Gestes/Externe/Hunt_Towards.pdf)
- [NIME 2002 — The importance of parameter mapping](https://www.nime.org/proceedings/2002/nime2002_088.pdf)
- [MIT Docubase — Wekinator](https://docubase.mit.edu/tools/wekinator/)
- [MDPI — Interactive Machine Learning framing](https://www.mdpi.com/1099-4300/22/12/1384)
- [ResearchGate — Assisted Interactive ML gesture-sound mapping](https://www.researchgate.net/publication/346487587_Towards_Assisted_Interactive_Machine_Learning_Exploring_Gesture-Sound_Mappings_Using_Reinforcement_Learning)
- [IDMIL / NIME18 — Morreale et al., NIME identity survey](https://www.idmil.org/wp-content/uploads/2022/06/NIME18_Morreale_etal_NimeIdentity.pdf)
- [arXiv — HCI Models for DMIs](https://arxiv.org/pdf/2010.01328)
- [ResearchGate — Embodied Cognition and Digital Musical Instruments](https://www.researchgate.net/publication/318753422_Embodied_Cognition_and_Digital_Musical_Instruments_Design_and_Performance)
- [Springer — Exploring Musical Agents with Embodied Perspectives](https://link.springer.com/chapter/10.1007/978-3-031-57892-2_17)
- [Springer — Challenges in Designing New Interfaces for Musical Expression](https://link.springer.com/chapter/10.1007/978-3-319-07668-3_62)
- [ResearchGate — Gesture-Sound Causality From the Audience's Perspective](https://www.researchgate.net/publication/316614469_Gesture-Sound_Causality_From_the_Audience's_Perspective_Investigating_the_Aesthetic_Experience_of_Performances_With_Digital_Musical_Instruments)
- [PsycNet — Gesture-Sound Causality record](https://psycnet.apa.org/record/2017-19177-001)
- [NIME 2020 — Dimension Space for Evaluation of Accessible DMIs](https://www.nime.org/proceedings/2020/nime2020_paper41.pdf)
