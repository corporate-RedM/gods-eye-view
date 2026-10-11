# OSIRIS integration

Source: https://github.com/simplifaisoul/osiris
Pinned revision: 83b8cd1be24d0d6134c0c1f775625330fcb87996.

`integrations/osiris/` contains selected TypeScript modules transpiled to
readable JavaScript with local imports and native Web Response handlers.
Child's Eye owns their HTTP transport, local access gate, camera catalogue,
UI, rendering and tool catalogue. It does not call a running OSIRIS app.
Local adaptations include Quick forecasting, one active run, native camera
frames, and API namespacing. `scripts/import-osiris.mjs` documents the initial
import; rerunning it requires reviewing and retaining those adaptations.

Forecast methodology credits MiroFish as documented in the source. Forecasts
are model scenarios, not verified predictions. Feed articles and camera images
retain their original providers' terms and attribution.

YOLOX-nano is distributed separately under Apache-2.0; see
`public/vendor/yolox/0.1.1rc0/LICENSE`.

## OSIRIS license

MIT License

Copyright (c) 2026 simplifaisoul

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
