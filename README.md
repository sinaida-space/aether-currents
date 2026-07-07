# AETHER CURRENTS

Conduct sound with your hands. A browser-based instrument: on-device hand
tracking drives granular audio synthesis and a real-time visual layer.
Static site, no build step, no framework — vanilla JS/CSS with ES modules.

## Gestures

```
RIGHT HAND x/y ... playhead position / pitch
RIGHT PINCH ...... grain size
LEFT HAND HEIGHT . grain density
TWO-HAND DISTANCE  filter + space
FIST ............. freeze the cloud
FAST OPEN PALM ... burst
```

## Running locally

```
python3 -m http.server 8123
```

Open `http://localhost:8123`. No build, no dependencies to install.

## Structure

```
index.html            app shell
css/main.css           all styles
js/main.js              boot module: consent, system check, mode select, camera
js/syscheck.js          capability probe (FULL vs LIGHT mode)
legal/                  privacy, terms, license
```

## Privacy

No cookies, no analytics, no server. Camera is processed entirely on-device.
See [legal/privacy.html](legal/privacy.html).

## License

Code: MIT. Output licensing (recordings you make with the tool) is covered
separately — see [legal/license.html](legal/license.html).

Made by Sinaida — [sinaida.eu](https://sinaida.eu)
