// Headless test-suite for CDQP Offline Audio Master.
// Loads the single-file app in Chromium (Playwright) and checks the DSP against reference signals
// (EBU Tech 3341 / 3342 for loudness), file encoders, and the main UI flows.
// Usage: npm test            (all tests)
//        npm test -- limiter (only tests whose name contains "limiter")
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(path.join(root, 'CDQP.Offline.Audio.Master.html')).href;
const filter = process.argv.slice(2).join(' ').toLowerCase();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (actual, expected, tol, what) => {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${what}: ${actual.toFixed(3)} (expected ${expected} ± ${tol})`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };

// Signal helpers, installed in the page once it has loaded.
function installHelpers() {
  window.T = {
    sr: 48000,
    tone(secs, dbfs, f = 1000, sr = 48000, phase = 0) {
      const n = Math.round(secs * sr), a = Math.pow(10, dbfs / 20), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / sr + phase);
      return x;
    },
    concat(...parts) {
      const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
    pcm(L, R = L, sr = 48000) {
      return { channels: [new Float32Array(L), new Float32Array(R)], sampleRate: sr, length: L.length, duration: L.length / sr };
    },
    noise(n, amp, seed = 1) {
      const r = seededRandom(seed), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = (r() * 2 - 1) * amp;
      return x;
    },
    peak(x, a = 0, b = x.length) { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i])); return p; },
    rms(x, a = 0, b = x.length) { let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, b - a)); },
    db(x) { return 20 * Math.log10(Math.max(x, 1e-12)); },
    // A short, musical-ish test mix: kick, bass, a centred "voice", hard-panned guitar and some hiss.
    mix(secs = 8, sr = 44100, kickLevel = 0.8) {
      const n = Math.round(secs * sr), L = new Float32Array(n), R = new Float32Array(n), r = seededRandom(9);
      for (let i = 0; i < n; i++) {
        const t = i / sr, beat = t % 0.5;
        const kick = kickLevel * Math.exp(-beat * 22) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat);
        const bass = 0.18 * Math.sin(2 * Math.PI * 55 * t);
        const voice = 0.2 * Math.sin(2 * Math.PI * 330 * t + 2 * Math.sin(2 * Math.PI * 5 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t));
        const guitar = 0.12 * Math.sin(2 * Math.PI * 196 * t) * Math.exp(-(t % 1) * 3);
        const hiss = (r() * 2 - 1) * 0.004;
        L[i] = kick + bass + voice + guitar + hiss;
        R[i] = kick + bass + voice + hiss;
      }
      return T.pcm(L, R, sr);
    },
    file(pcm, name = 'test.wav') { return new File([encodeWav(pcm, 'wav24')], name, { type: 'audio/wav' }); },
  };
}

// ---------------------------------------------------------------- loudness
test('loudness: EBU Tech 3341 integrated-loudness cases 1-5', async (page) => {
  const r = await page.evaluate(() => {
    const s = (secs, db) => T.tone(secs, db);
    const cases = [
      s(20, -23),
      s(20, -33),
      T.concat(s(10, -36), s(60, -23), s(10, -36)),
      T.concat(s(10, -72), s(10, -36), s(60, -23), s(10, -36), s(10, -72)),
      T.concat(s(20, -26), s(20.1, -20), s(20, -26)),
    ];
    return cases.map(x => measureLoudness(T.pcm(x)).lufs);
  });
  [-23, -33, -23, -23, -23].forEach((exp, i) => near(r[i], exp, 0.1, `case ${i + 1}`));
});

test('loudness: EBU Tech 3342 loudness-range cases 1-4', async (page) => {
  const r = await page.evaluate(() => {
    const s = (secs, db) => T.tone(secs, db);
    return [
      T.concat(s(20, -20), s(20, -30)),
      T.concat(s(20, -20), s(20, -15)),
      T.concat(s(20, -40), s(20, -20)),
      T.concat(s(20, -50), s(20, -35), s(20, -20), s(20, -35), s(20, -50)),
    ].map(x => measureLoudness(T.pcm(x)).lra);
  });
  [10, 5, 20, 15].forEach((exp, i) => near(r[i], exp, 1, `LRA case ${i + 1}`));
});

test('true peak: inter-sample peak of a quarter-rate sine is detected', async (page) => {
  const r = await page.evaluate(() => {
    const x = T.tone(1, -6.0206, 12000, 48000, Math.PI / 4); // samples sit at ±0.707 of the true peak
    const pcm = T.pcm(x);
    return { sample: T.db(T.peak(x)), tp4: truePeak(pcm, 4), tp8: truePeak(pcm, 8) };
  });
  near(r.sample, -9.03, 0.05, 'sample peak');
  near(r.tp4, -6.02, 0.3, 'true peak (4x)');
  near(r.tp8, -6.02, 0.3, 'true peak (8x)');
});

// ---------------------------------------------------------------- dynamics
test('limiter: peaks stay under the ceiling and the gain never steps', async (page) => {
  const r = await page.evaluate(() => {
    const out = {};
    for (const mode of ['transparent', 'brick', 'soft']) {
      const quiet = T.tone(0.5, -20, 440), loud = T.tone(0.5, 0, 440);
      const x = T.concat(quiet, loud, quiet, loud), pcm = T.pcm(x);
      lookaheadLimiter(pcm, -1, 120, mode);
      const y = pcm.channels[0];
      let peak = 0, step = 0, prev = null;
      for (let i = 0; i < x.length; i++) {
        peak = Math.max(peak, Math.abs(y[i]));
        if (Math.abs(x[i]) > 0.02) { const g = y[i] / x[i]; if (prev !== null) step = Math.max(step, Math.abs(g - prev)); prev = g; } else prev = null;
      }
      out[mode] = { peak: T.db(peak), step };
    }
    return out;
  });
  for (const [mode, v] of Object.entries(r)) {
    ok(v.peak <= -1 + 1e-4, `${mode}: peak ${v.peak.toFixed(3)} dBFS above the -1 dB ceiling`);
    if (mode !== 'soft') ok(v.step < 0.01, `${mode}: gain jumps by ${v.step.toFixed(4)} between samples`);
  }
});

test('tone graph: processed output is time-aligned with the source', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 44100, x = T.noise(sr * 2, 0.05, 3), pcm = T.pcm(x, x, sr);
    const s = { ...currentSettings(), hpf: 20, lpf: 22000, hpfSlope: 12, eq: EQ_FREQS.map(() => 0), mud: 0, presence: 0, air: 0, deess: 0,
      lowBandComp: 58, compRatio: 1.6, attack: 20, release: 200, repairGlue: 40, sat: 2, harmonicExciter: 0, width: 100 };
    const y = (await renderToneChain(pcm, s)).channels[0];
    let best = -Infinity, lag = 0;
    for (let d = -400; d <= 400; d++) {
      let c = 0; for (let i = 2000; i < 60000; i++) c += x[i] * y[i + d];
      if (c > best) { best = c; lag = d; }
    }
    return lag;
  });
  ok(Math.abs(r) <= 1, `output is shifted by ${r} samples`);
});

test('tone graph: low-band control is flat below its threshold (no crossover notch)', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 44100, out = {};
    const s = { ...currentSettings(), hpf: 15, lpf: 22000, hpfSlope: 12, eq: EQ_FREQS.map(() => 0), mud: 0, presence: 0, air: 0, deess: 0,
      lowBandComp: 58, compRatio: 1, repairGlue: 0, sat: 0, harmonicExciter: 0, width: 100 };
    for (const f of [80, 160, 250, 330, 450, 1000]) {
      const x = T.tone(1, -45, f, sr), y = (await renderToneChain(T.pcm(x, x, sr), s)).channels[0];
      out[f] = T.db(T.rms(y, sr / 2) / T.rms(x, sr / 2));
    }
    return out;
  });
  for (const [f, g] of Object.entries(r)) near(g, 0, 0.5, `gain at ${f} Hz`);
});

test('tone graph: high-pass slopes match their labels', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 48000, out = {};
    for (const slope of [12, 24]) {
      const s = { ...currentSettings(), hpf: 100, hpfSlope: slope, lpf: 22000, eq: EQ_FREQS.map(() => 0), mud: 0, presence: 0, air: 0, deess: 0,
        lowBandComp: 0, compRatio: 1, repairGlue: 0, sat: 0, harmonicExciter: 0, width: 100 };
      for (const f of [50, 100]) {
        const x = T.tone(2, -20, f, sr), y = (await renderToneChain(T.pcm(x, x, sr), s)).channels[0];
        out[`${slope}@${f}`] = T.db(T.rms(y, sr) / T.rms(x, sr));
      }
    }
    return out;
  });
  near(r['12@100'], -3.01, 0.3, '12 dB/oct at cutoff');
  near(r['24@100'], -3.01, 0.3, '24 dB/oct at cutoff');
  near(r['12@50'], -12.3, 1, '12 dB/oct one octave below');
  near(r['24@50'], -24.1, 1, '24 dB/oct one octave below');
});

test('mastering: end-to-end render reaches the LUFS target under the true-peak ceiling', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('master');
    await importFile(T.file(T.mix(10, 44100, 0.3)));
    const res = {};
    for (const key of ['masterDefault', 'masterPop', 'masterEdm']) {
      applyPreset(key, false);
      await renderCurrent();
      res[key] = { lufs: state.analysis.lufs, tp: state.analysis.tp, target: PRESETS[key].targetLufs, ceiling: PRESETS[key].ceiling };
    }
    return res;
  });
  for (const [k, v] of Object.entries(r)) {
    near(v.lufs, v.target, 0.3, `${k} integrated loudness`);
    ok(v.tp <= v.ceiling + 0.05, `${k}: true peak ${v.tp.toFixed(2)} dBTP above ceiling ${v.ceiling}`);
  }
});

test('mastering: very dynamic sources are capped at 6 dB of limiting and the status says so', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('master');
    await importFile(T.file(T.mix(10, 44100, 1.6)));
    applyPreset('masterEdm', false);
    await renderCurrent();
    return { lufs: state.analysis.lufs, tp: state.analysis.tp, status: document.getElementById('simpleStatus').textContent, note: ux('targetLimited') };
  });
  ok(r.lufs < -8.8 - 0.5, `expected the loudness to stay below target, got ${r.lufs.toFixed(2)}`);
  ok(r.status.includes(r.note), `status does not explain the capped target: "${r.status}"`);
  ok(r.tp <= -0.95, `true peak ${r.tp.toFixed(2)} above ceiling`);
});

// ---------------------------------------------------------------- separation / restoration
test('extraction: stems sum back to the source and centred content lands in the vocal stem', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('extract');
    const sr = 44100, n = sr * 6, voice = T.tone(6, -14, 440, sr), side = T.tone(6, -14, 3000, sr), L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = voice[i] + side[i]; R[i] = voice[i] - side[i]; }
    await importFile(T.file(T.pcm(L, R, sr)));
    state.task = 'both'; applyTaskDefault();
    await extractAudio();
    const v = state.stems.vocals, ins = state.stems.instrumental, src = state.pcm;
    let err = 0, ref = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const d = src.channels[c][i] - v.channels[c][i] - ins.channels[c][i]; err += d * d; ref += src.channels[c][i] ** 2; }
    const band = (pcm, f) => { const y = filterArray(filterArray(pcm.channels[0], biquadCoeffs('highpass', f * 0.8, 2, 0, sr)), biquadCoeffs('lowpass', f * 1.25, 2, 0, sr)); return T.rms(y, sr, n - sr); };
    return { residual: T.db(Math.sqrt(err / ref)), voiceInVocals: T.db(band(v, 440) / band(src, 440)), sideInVocals: T.db(band(v, 3000) / band(src, 3000)) };
  });
  ok(r.residual < -20, `stems do not sum back to the source (${r.residual.toFixed(1)} dB)`);
  ok(r.voiceInVocals > -6, `centred tone too weak in vocal stem (${r.voiceInVocals.toFixed(1)} dB)`);
  ok(r.sideInVocals < r.voiceInVocals - 10, `side content leaks into vocals (${r.sideInVocals.toFixed(1)} dB)`);
});

test('denoise: stationary hiss is reduced while the tone survives', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 44100, n = sr * 6, hiss = T.noise(n, 0.02, 5), tone = T.tone(6, -12, 600, sr), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = hiss[i] + (i > sr * 3 ? tone[i] : 0);
    const y = (await workerDenoise(T.pcm(x, x, sr), 50)).channels[0];
    const toneBand = a => T.rms(filterArray(filterArray(a, biquadCoeffs('highpass', 500, 3, 0, sr)), biquadCoeffs('lowpass', 720, 3, 0, sr)), sr * 4, n - sr / 2);
    return { hiss: T.db(T.rms(y, sr, sr * 3) / T.rms(x, sr, sr * 3)), tone: T.db(toneBand(y) / toneBand(x)) };
  });
  ok(r.hiss < -4, `hiss only reduced by ${(-r.hiss).toFixed(1)} dB`);
  ok(r.tone > -2, `tone attenuated by ${(-r.tone).toFixed(1)} dB`);
});

test('denoise: a loud opening is not mistaken for the noise floor', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 44100, n = sr * 8, hiss = T.noise(n, 0.01, 11), chord = T.concat(T.tone(3, -10, 440, sr), new Float32Array(n - 3 * sr)), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = hiss[i] + chord[i] + (i < 3 * sr ? 0.5 * Math.sin(2 * Math.PI * 660 * i / sr) * 0.3 : 0);
    const y = (await workerDenoise(T.pcm(x, x, sr), 40)).channels[0];
    return { opening: T.db(T.rms(y, 0, sr) / T.rms(x, 0, sr)), tail: T.db(T.rms(y, 5 * sr, 8 * sr) / T.rms(x, 5 * sr, 8 * sr)) };
  });
  ok(r.opening > -1.5, `loud opening attenuated by ${(-r.opening).toFixed(1)} dB`);
  ok(r.tail < -3, `noise-only tail only reduced by ${(-r.tail).toFixed(1)} dB`);
});

test('extraction: higher vocal clarity lets less instrument bleed into the vocal stem', async (page) => {
  const r = await page.evaluate(async () => {
    const sr = 44100, n = sr * 4, voice = T.tone(4, -14, 800, sr), side = T.noise(n, 0.08, 8), L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = voice[i] + side[i]; R[i] = voice[i] - 0.4 * side[i]; }
    const pcm = T.pcm(L, R, sr), s = currentSettings(), out = {};
    const band = (a, lo, hi) => { const h = biquadCoeffs('highpass', lo, Math.SQRT1_2, 0, sr), l = biquadCoeffs('lowpass', hi, Math.SQRT1_2, 0, sr); return T.rms(filterArray(filterArray(filterArray(filterArray(a, h), h), l), l), sr, n - sr); };
    for (const clarity of [0, 100]) {
      const v = (await workerExtract(pcm, { ...s, vocalClarity: clarity }, false)).vocals.channels[0];
      out[clarity] = { bleed: band(v, 5000, 10000), voice: band(v, 650, 1000) };
    }
    return { bleed: T.db(out[100].bleed / out[0].bleed), voice: T.db(out[100].voice / band(L, 650, 1000)) };
  });
  ok(r.bleed < -6, `vocal stem does not get cleaner with clarity (${r.bleed.toFixed(2)} dB)`);
  ok(r.voice > -3, `centred voice lost at high clarity (${r.voice.toFixed(2)} dB)`);
});

test('restoration: denoise and separation never blow up at the edges of the file', async (page) => {
  const r = await page.evaluate(async () => {
    // 221183 samples: the last sample falls at the very end of the last analysis window (worst case for overlap-add)
    const sr = 44100, n = 221183, hiss = T.noise(n, 0.01, 21), L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr, music = i > sr ? 0.3 * Math.sin(2 * Math.PI * (200 + 400 * t) * t) + 0.1 * Math.sin(2 * Math.PI * 3100 * t) : 0;
      L[i] = music + hiss[i]; R[i] = 0.8 * music + hiss[i];
    }
    const pcm = T.pcm(L, R, sr), inPeak = T.peak(L), edgePeak = a => Math.max(T.peak(a, 0, 2048), T.peak(a, a.length - 2048));
    const d = await workerDenoise(pcm, 45), st = await workerExtract(pcm, currentSettings(), true);
    return { inPeak, denoise: T.peak(d.channels[0]), denoiseEdge: edgePeak(d.channels[0]), vocalEdge: edgePeak(st.vocals.channels[0]), instEdge: edgePeak(st.instrumental.channels[0]) };
  });
  ok(r.denoise <= r.inPeak * 1.1, `denoise output peak ${r.denoise.toFixed(3)} above input peak ${r.inPeak.toFixed(3)}`);
  for (const k of ['denoiseEdge', 'vocalEdge', 'instEdge']) ok(r[k] <= r.inPeak * 1.1, `${k}: ${r[k].toFixed(3)} (input peak ${r.inPeak.toFixed(3)})`);
});

// ---------------------------------------------------------------- file formats
test('WAV export: 16/24/32-bit files decode back to the same audio (no 16-bit wrap-around)', async (page) => {
  const r = await page.evaluate(async () => {
    const ctx = new OfflineAudioContext(2, 1, 44100), out = {};
    const x = T.tone(0.5, -3, 997, 44100); x.fill(1, 100, 4100); // 4000 full-scale samples: any wrap-around shows up
    const pcm = T.pcm(x, x, 44100);
    for (const fmt of ['wav16', 'wav24', 'wav32']) {
      const buf = await ctx.decodeAudioData(await encodeWav(pcm, fmt).arrayBuffer()), y = buf.getChannelData(0);
      let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
      let fullScale = 1; for (let i = 100; i < 4100; i++) fullScale = Math.min(fullScale, y[i]);
      out[fmt] = { err, len: buf.length, sr: buf.sampleRate, fullScale };
    }
    return out;
  });
  near(r.wav16.err, 0, 1.6 / 32768, 'wav16 max error');
  near(r.wav24.err, 0, 2 / 8388608, 'wav24 max error');
  near(r.wav32.err, 0, 1e-7, 'wav32 max error');
  ok(r.wav16.fullScale > 0.99, `16-bit full-scale sample wrapped to ${r.wav16.fullScale}`);
  for (const v of Object.values(r)) ok(v.len === 22050 && v.sr === 44100, 'length / sample-rate mismatch');
});

test('MIDI export: note timing follows the selected rhythm', async (page) => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const rhythm of ['steady', 'mixed', 'syncopated', 'arcade']) {
      const notes = [60, 62, 64, 60, 67, 69, 60, 72];
      const bytes = new Uint8Array(await buildMidiBlobFromNotes(notes, 120, 1, rhythm).arrayBuffer());
      const u32 = o => (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
      let p = 22, tick = 0; const end = 22 + u32(18), ons = [], offs = [];
      const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = v << 7 | b & 127; } while (b & 128); return v; };
      while (p < end) {
        tick += vlq(); const st = bytes[p++];
        if (st === 0xff) { p++; const len = vlq(); p += len; continue; }
        const note = bytes[p++], vel = bytes[p++];
        if ((st & 0xf0) === 0x90 && vel) ons.push([tick, note]); else offs.push([tick, note]);
      }
      const expected = []; let at = 0;
      notes.forEach((_, i) => { expected.push(at); at += rhythmTicks(i, 480, rhythm); });
      out[rhythm] = { ons: ons.map(o => o[0]), expected, notes: ons.map(o => o[1]), offs: offs.length,
        header: String.fromCharCode(...bytes.slice(0, 4)) + String.fromCharCode(...bytes.slice(14, 18)) };
    }
    return out;
  });
  for (const [rhythm, v] of Object.entries(r)) {
    ok(v.header === 'MThdMTrk', `${rhythm}: bad chunk headers`);
    ok(JSON.stringify(v.ons) === JSON.stringify(v.expected), `${rhythm}: note-on ticks ${v.ons} != ${v.expected}`);
    ok(v.offs === 8 && JSON.stringify(v.notes) === JSON.stringify([60, 62, 64, 60, 67, 69, 60, 72]), `${rhythm}: notes / note-offs mismatch`);
  }
});

test('import: 3- and 5-channel files keep their right channel in the stereo down-mix', async (page) => {
  const r = await page.evaluate(() => {
    const out = {};
    for (const N of [3, 5]) {
      const ctx = new OfflineAudioContext(N, 4800, 48000), buf = ctx.createBuffer(N, 4800, 48000);
      buf.getChannelData(0).set(T.tone(0.1, -12, 300)); buf.getChannelData(1).set(T.tone(0.1, -12, 700));
      const pcm = downmixBuffer(buf, null);
      out[N] = { L: T.db(T.rms(pcm.channels[0])), R: T.db(T.rms(pcm.channels[1])), same: pcm.channels[0][123] === pcm.channels[1][123] };
    }
    return out;
  });
  for (const [N, v] of Object.entries(r)) ok(!v.same && Math.abs(v.L - v.R) < 0.5 && v.R > -20, `${N} channels: R lost (${JSON.stringify(v)})`);
});

// ---------------------------------------------------------------- UI
test('UI: actions without content stay disabled after processing', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('master');
    await importFile(T.file(T.mix(3)));
    await renderCurrent();
    return ['midiPlay', 'midiDownload', 'musicMidiConvert', 'musicMidiDownload', 'transformB', 'transformDownload', 'exVocals', 'sExInst']
      .filter(id => !document.getElementById(id).disabled);
  });
  ok(r.length === 0, `enabled without content: ${r.join(', ')}`);
});

test('UI: every help button opens a non-empty, localised dialog that Escape closes', async (page) => {
  const keys = await page.evaluate(() => [...document.querySelectorAll('.helpQ')].map(b => b.dataset.help));
  for (const lang of ['en', 'fr']) {
    await page.evaluate(l => applyLanguage(l), lang);
    for (const k of keys) {
      const text = await page.evaluate(k => { showHelp(k); return document.getElementById('helpText').textContent; }, k);
      ok(text.length > 40, `help "${k}" (${lang}) is empty`);
      await page.keyboard.press('Escape');
      ok(!(await page.evaluate(() => document.getElementById('helpModal').classList.contains('open'))), 'Escape did not close the help dialog');
    }
  }
  await page.evaluate(() => applyLanguage('en'));
});

test('UI: music and vocal correction cards have distinct titles in every language', async (page) => {
  const r = await page.evaluate(() => LANGS.map(([c]) => [c, I18N[c].musicCorrection, I18N[c].audioCorrection]).filter(x => !x[1] || x[1] === x[2]));
  ok(r.length === 0, `duplicate titles: ${JSON.stringify(r)}`);
});

test('UI: cancelling a running separation settles the pending job', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('extract');
    await importFile(T.file(T.mix(20)));
    const job = extractAudio().then(() => 'settled');
    await new Promise(res => setTimeout(res, 150));
    cancelProcessing();
    return Promise.race([job, new Promise(res => setTimeout(() => res('pending'), 3000))]).then(s => ({ s, processing: state.processing, stems: !!state.stems }));
  });
  ok(r.s === 'settled' && !r.processing && !r.stems, `after cancel: ${JSON.stringify(r)}`);
});

test('effects: every transformer effect renders finite audio', async (page) => {
  const r = await page.evaluate(async () => {
    openModule('transformer');
    await importFile(T.file(T.mix(4)));
    const out = {};
    for (const o of document.querySelectorAll('#transformEffect option')) {
      document.getElementById('transformEffect').value = o.value;
      await processTransform();
      const y = state.transformRendered; let finite = true, peak = 0;
      for (const ch of y.channels) for (const v of ch) { if (!Number.isFinite(v)) finite = false; peak = Math.max(peak, Math.abs(v)); }
      out[o.value] = { finite, peak, secs: y.duration };
    }
    return out;
  });
  for (const [fx, v] of Object.entries(r)) ok(v.finite && v.peak > 0.01 && v.peak <= 1 && v.secs > 1, `${fx}: ${JSON.stringify(v)}`);
});

// ---------------------------------------------------------------- accessibility / hosting
test('accessibility: no serious or critical axe-core violations in the main views', async (page) => {
  const axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await page.addScriptTag({ content: axeSource });
  const found = [];
  for (const theme of ['dark', 'light']) {
    for (const view of ['home', 'master', 'advanced', 'extract', 'midi', 'transformer', 'help']) {
      const r = await page.evaluate(async ([theme, view]) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.motion = 'off';
        closeHelp();
        if (view === 'home') showHome();
        else if (view === 'master') { openModule('master'); if (!state.file) { await importFile(T.file(T.mix(3))); await renderCurrent(); } }
        else if (view === 'advanced') { openModule('master'); setMode(true); }
        else if (view === 'help') { openModule('master'); showHelp('master'); }
        else openModule(view);
        await new Promise(res => setTimeout(res, 400));
        const out = await axe.run(document, { resultTypes: ['violations'] });
        return out.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id} (${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')})`);
      }, [theme, view]);
      r.forEach(v => found.push(`${theme}/${view}: ${v}`));
    }
  }
  ok(found.length === 0, found.join('\n      '));
});

test('hosting: served over HTTP the app registers its service worker and reloads offline', async (page) => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/CDQP.Offline.Audio.Master.html`;
  try {
    await page.goto(url);
    const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return !!reg.active; });
    ok(sw, 'service worker not active');
    await page.waitForFunction(() => !!document.querySelector('link[rel=manifest]'));
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    ok(manifest.start_url && manifest.icons.length >= 3, 'manifest incomplete');
    await page.context().setOffline(true);
    await page.reload();
    const offline = await page.evaluate(() => ({ title: document.title, ready: typeof state === 'object' && document.getElementById('home').offsetHeight > 0 }));
    ok(offline.ready && offline.title.includes('Audio Master'), `offline reload failed: ${JSON.stringify(offline)}`);
  } finally {
    await page.context().setOffline(false);
    server.close();
  }
});

// ---------------------------------------------------------------- runner
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0, ran = 0;
const pageErrors = [];
for (const t of tests) {
  if (filter && !t.name.toLowerCase().includes(filter)) continue;
  ran++;
  const page = await browser.newPage();
  page.on('pageerror', e => pageErrors.push(`${t.name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(`${t.name}: ${m.text()}`); });
  await page.goto(APP);
  await page.evaluate(installHelpers);
  const t0 = Date.now();
  try {
    await t.fn(page);
    console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n      ${e.message.split('\n')[0]}`);
  }
  await page.close();
}
await browser.close();
if (pageErrors.length) { failed++; console.log('\nPage errors:\n  ' + pageErrors.join('\n  ')); }
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
