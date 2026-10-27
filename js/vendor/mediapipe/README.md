# MediaPipe Tasks Vision

Hand tracking runs on MediaPipe. Everything it needs is served from this
folder, so the page asks no other host for anything and works offline.

| File | From |
|---|---|
| `0.10.14/vision_bundle.mjs`, `0.10.14/wasm/*` | the npm package `@mediapipe/tasks-vision@0.10.14`, unchanged |
| `0.10.14/models/hand_landmarker.task` | `storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/` |

The wasm build without SIMD is left out, since every supported browser
has SIMD.

License: Apache License 2.0, © Google LLC, see `LICENSE`.
The model is published by Google under the same license.

To upgrade: add a folder named after the new version and change `MEDIAPIPE`
in `js/tracking/tracker.js`.
