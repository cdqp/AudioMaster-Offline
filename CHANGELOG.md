# Changelog

## 1.2.0 — 2026-10-03

### Added
- **Installable offline app** when the folder is hosted (GitHub Pages or any HTTPS server): web manifest, icons
  and a service worker that keeps the app available without a connection after the first visit and picks up new
  releases on the next one. An *Install app* button appears when the browser offers installation. Opening the
  HTML file from disk is unchanged.
- Accessibility test (axe-core, both themes, main views) and an offline/hosting test in the suite.
- `CONTRIBUTING.md`, issue templates, Dependabot configuration and `.editorconfig`.

### Fixed
- The footer (FAQ / help, credits) was hidden on the home page: the workspace section was never closed, so the
  footer lived inside it.
- Every slider and drop-down now has an accessible name taken from its visible label, and sliders announce their
  formatted value (e.g. "230 ms"); seek bars are labelled.
- Small blue labels in the light theme reached only 3.6:1 contrast (now above 4.5:1).
- Page structure: one `main` landmark, a level-one heading on every view, a skip link for keyboard users.

## 1.1.0 — 2026-10-03

### Fixed — audio
- **Low-band control** (Suno Repair, Cheap Studio Repair 2, Repair Cheap 3): the crossover summed a 6 ms-late
  compressed low band with an undelayed high band, cutting a ~9 dB notch around 250 Hz, while resonant filters and
  the compressor's automatic make-up gain boosted the lows by up to 7–10 dB. The band split is now a true
  Linkwitz-Riley crossover, time-aligned and make-up compensated: flat below threshold, compression above.
- **Web Audio high/low-pass filters** were configured with a linear Q although Web Audio expects a resonance in dB,
  so every high-pass, low-pass and crossover filter had a small resonant bump. Fixed for the render and the preview.
- **24 dB/oct high-pass** actually cascaded three filters (36 dB/oct); it is now a 4th-order Butterworth.
- **Render latency**: every compressor (6 ms each) and the 4× oversampled saturation (192 samples) delayed the
  processed audio and cut the end of the file. Output is now sample-aligned with the source.
- **Loudness meter**: the K-weighting filter read about 0.25 dB low; it now reproduces the ITU-R BS.1770 reference
  coefficients and passes the EBU Tech 3341 test cases. Loudness range follows EBU Tech 3342 (3 s windows every
  100 ms, −20 LU relative gate).
- **Loudness target**: the make-up gain was capped at +5.5 dB regardless of headroom, so quiet or dynamic sources
  ended several dB below the target. The gain is now iterated (secant method) until the target is met, with the
  true-peak trim included, and only limited by a 6 dB maximum limiter reduction — the status line explains when
  that cap applies.
- **Limiter**: gain reduction used to jump in one step when a peak entered the look-ahead window; it now ramps
  smoothly into each peak. *Soft* mode saturates gently instead of hard-clipping.
- **Live A/B preview** used a different chain from the render (other de-esser frequency, no low-band control, glue
  or exciter, no high-pass slope). Both now share one tone graph, and A is delayed to stay aligned with B.
- **16-bit export** could wrap a full-scale sample to −32768 (a click) because dither was added after clipping.
- **3- and 5-channel files** lost their right channel in the stereo down-mix.
- **Overview meters** showed the source loudness after a −3 dB safety normalisation instead of the file's real values.
- **Denoise and separation edges**: the overlap-add normalisation divided by a near-zero window sum on the first
  and last samples of the file, which could produce huge spikes there. Frames now start half a window early so
  every sample is fully overlapped.
- **Denoise** took its first noise estimate from the first frame, so songs that open loud had their intro treated
  as noise; it now starts from the quietest 10 % of the track.
- **Vocal clarity** (stem separation) was sent to the processor but never used; it now controls how strictly
  ambiguous content is assigned to the vocal (less bleed when raised; neutral at 50 %).
- **Speed up / Chipmunk** aliased high frequencies; the signal is now band-limited before resampling.
- **Exported MIDI** did not match the preview for the mixed, syncopated and arcade rhythms (notes were placed after
  the previous note's end instead of on the beat grid).
- *Cheap Studio Repair 2* asks for a 620 Hz box cut but the slider stopped at 400 Hz (range is now 200–800 Hz).

### Fixed — interface
- After any processing every button was re-enabled, including MIDI download, stem preview or effect B without
  content.
- Cancelling during denoise or separation left the job pending forever (and its audio in memory).
- A failed import discarded the current file.
- The *Music repair* card showed the vocal module's title in every language.
- The Suno help button opened an empty dialog, and help texts were French-only (now English and French).
- The green "ready to export" button was unreadable in the light theme.
- `A` / `B` shortcuts fired with `Ctrl`/`⌘` (e.g. `Ctrl+A`), and `Space` on a focused button triggered both the
  button and playback. *Music to MIDI* could freeze the page on long passages without notes.
- Hard-coded French or English strings (footer, A/B hint, MIDI conversion, presets, overview title) now follow the
  selected language (English and French, other languages fall back to English).

### Improved
- Reverb effects use a convolution with a synthetic stereo room (dense tail, damping) that keeps the former early
  reflections, instead of seven discrete echoes.
- Waveform shows a playhead; the centre line is visible in the light theme.
- `Esc` closes dialogs and menus, arrow keys move through the language list, dialogs are announced to assistive
  technologies, every drop zone is keyboard-operable, the first visit follows the system theme, and a message is
  shown when JavaScript is disabled.
- Page metadata (description, theme colour, built-in icon).

### Performance
- Stem separation about 2× faster and denoise about 1.4× faster (shared real-pair FFTs, precomputed twiddles,
  reused buffers, instrumental computed in the time domain, no `Math.hypot` in hot loops). On its own, this
  rewrite produces the same output as before to within floating-point rounding.
- Mastering render about 2× faster (single-pass loudness, precomputed true-peak interpolator).
- The waveform no longer re-reads every sample on each redraw (peak summary cache); WAV encoding uses typed arrays;
  the background animation no longer forces a style lookup every frame.

### Repository
- README rewritten, changelog, screenshots, `index.html` for GitHub Pages.
- Headless test-suite (`npm test`, 22 tests) and static checks (`npm run lint`), run by GitHub Actions.

## 1.0.0

Initial public version.
