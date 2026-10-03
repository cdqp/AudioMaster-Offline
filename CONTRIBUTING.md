# Contributing

Thanks for helping improve CDQP Offline Audio Master! Bug reports, presets, translations and code are all welcome.

## Ground rules

- **One file.** The app must keep working when `CDQP.Offline.Audio.Master.html` is downloaded and opened on its
  own: styles, scripts, translations and the Web Worker source stay inline.
- **Nothing leaves the device.** No network requests, analytics, CDNs or external fonts. The test-suite checks the
  app end to end in a browser; a quick look at the browser's Network tab is a good habit too.
- **No runtime dependencies.** Development tools (Playwright for the tests) are fine; the page itself uses only
  browser APIs (Web Audio, Web Workers, Canvas).

## Getting set up

```bash
git clone https://github.com/cdqp/AudioMaster-Offline.git
cd AudioMaster-Offline
npm install
npx playwright install chromium
npm run lint && npm test
```

To try the app, open the HTML file in a browser. To try the installable (PWA) version, serve the folder over HTTP,
for example `npx http-server -c-1 .`, and open `http://localhost:8080/`.

## Where things live in the HTML file

| Part | What to look for |
| --- | --- |
| Styles | the `<style>` blocks in `<head>`; later blocks override earlier ones (design tokens on `:root` and `html[data-theme="light"]`) |
| Markup | `#home` (module cards), `#workspace` (simple / advanced panes), `#midiPane`, `#transformerPane` |
| Translations | `LANGS`, `I18N` (one object per language), `UX_COPY` and the `Object.assign(UX_COPY.en/fr, …)` additions, `HELP_EN` / `HELP_FR`, `FAQ_EN` / `FAQ_FR` |
| Presets | `PRESETS` and `PRESET_GROUPS` |
| Measurements | `measureLoudness` (BS.1770-4 / EBU R128), `truePeak`, `measurePCMQuick` |
| Mastering / repair render | `renderCurrent` → `renderToneChain` → `buildToneGraph`, then `lookaheadLimiter` |
| Live A/B preview | `setupPreview`, `updatePreviewGraph` (uses the same `buildToneGraph`) |
| Separation and denoise | `workerScript()` returns the Web Worker source as a template literal: do not use backticks or `${` inside it |
| MIDI | `makeMidiMelody`, `buildMidiBlobFromNotes`, `convertMusicToMidi` |
| Effects | `processTransform` and the `*PCM` helpers (`speedPCM`, `reverbPCM`, …) |
| Event wiring and start-up | `bind()` and `init()` at the end of the script |

## Common changes

- **A new UI string**: add it to `UX_COPY.en` and `UX_COPY.fr` (other languages fall back to English) and read it
  with `ux('key')`; for strings already in `I18N`, use `t('key')` or a `data-i18n="key"` attribute.
- **A new preset**: add an entry to `PRESETS`, list it in `PRESET_GROUPS`, add a task button in `renderTasks()` and
  label / description keys in the translations.
- **DSP changes**: add or update a test in `tests/run.mjs` with a reference signal whose expected result you can
  justify (see the loudness, limiter and filter tests for examples).

## Tests

`npm test` runs the suite in headless Chromium; `npm test -- <words>` runs only the tests whose name contains those
words. `npm run lint` checks that the scripts compile, that element ids are unique and that every `$('#id')` lookup
resolves. Both run on every push and pull request.

## Pull requests

Keep each pull request focused, describe what changed and how you checked it, and update `CHANGELOG.md`.
