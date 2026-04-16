# TLDR

Browser extension for text-to-speech using Kokoro TTS.

## Architecture

- `extension/offscreen.html` / `offscreen.js` — Offscreen document (kokoro-js TTS engine, ONNX Runtime WASM)
- `extension/background.js` — Service worker (message routing, offscreen lifecycle)
- `extension/popup.html` / `popup.css` / `popup.js` — Extension popup (settings, history, model status)
- `extension/content.js` / `content.css` — Content script (FAB, player, highlighting)
- `extension/lib/storage.js` — Storage utilities
- `build.js` — esbuild config, bundles offscreen.js and copies static files to `dist/`

## Build

```bash
npm install && npm run build
```

Load `dist/` as unpacked extension in Chrome.

## Design Tokens

The UI uses a blue-tinted dark palette:
- Backgrounds: `#16162b` (body), `#1a1a2e` (cards/inputs), `#252547` (hover)
- Borders: `#2a2a45`
- Text: `#e0e0e0` (primary), `#ccc` (secondary), `#999` (muted), `#888` (dim)
- Accent: `#ff6b4a` / `#e55a3a` (hover)
