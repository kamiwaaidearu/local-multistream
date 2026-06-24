import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectEncoder,
  pickPreset,
  resolveEncoder,
  buildVideoArgs,
  NVENC_PRESETS,
  X264_PRESETS,
  DEFAULT_NVENC_PRESET,
  DEFAULT_X264_PRESET,
} from './encoderConfig.js';

test('the defaults are themselves valid presets', () => {
  assert.ok(NVENC_PRESETS.has(DEFAULT_NVENC_PRESET));
  assert.ok(X264_PRESETS.has(DEFAULT_X264_PRESET));
});

test('selectEncoder: libx264 mode never uses NVENC, even when available', () => {
  assert.deepEqual(selectEncoder('libx264', true), { encoder: 'libx264', forcedNvencUnavailable: false });
  assert.deepEqual(selectEncoder('libx264', false), { encoder: 'libx264', forcedNvencUnavailable: false });
});

test('selectEncoder: auto uses NVENC when supported, else falls back silently', () => {
  assert.deepEqual(selectEncoder('auto', true), { encoder: 'h264_nvenc', forcedNvencUnavailable: false });
  // Silent fallback — auto is allowed to land on libx264 without complaint.
  assert.deepEqual(selectEncoder('auto', false), { encoder: 'libx264', forcedNvencUnavailable: false });
});

test('selectEncoder: forced nvenc uses NVENC when supported, else falls back and flags a warning', () => {
  assert.deepEqual(selectEncoder('nvenc', true), { encoder: 'h264_nvenc', forcedNvencUnavailable: false });
  // The only case the caller should warn about: the operator asked for NVENC but it isn't there.
  assert.deepEqual(selectEncoder('nvenc', false), { encoder: 'libx264', forcedNvencUnavailable: true });
});

test('pickPreset: valid preset is accepted (and normalized)', () => {
  assert.deepEqual(pickPreset('p6', 'h264_nvenc'), { preset: 'p6', rejected: null });
  assert.deepEqual(pickPreset('  P6 ', 'h264_nvenc'), { preset: 'p6', rejected: null });
  assert.deepEqual(pickPreset('faster', 'libx264'), { preset: 'faster', rejected: null });
  assert.deepEqual(pickPreset('PLACEBO', 'libx264'), { preset: 'placebo', rejected: null });
});

test('pickPreset: empty/unset falls back to the default silently (not "rejected")', () => {
  assert.deepEqual(pickPreset('', 'h264_nvenc'), { preset: DEFAULT_NVENC_PRESET, rejected: null });
  assert.deepEqual(pickPreset('   ', 'libx264'), { preset: DEFAULT_X264_PRESET, rejected: null });
});

test('pickPreset: unknown value falls back to the default and reports the original for warning', () => {
  assert.deepEqual(pickPreset('turbo', 'h264_nvenc'), { preset: DEFAULT_NVENC_PRESET, rejected: 'turbo' });
  assert.deepEqual(pickPreset('ludicrous', 'libx264'), { preset: DEFAULT_X264_PRESET, rejected: 'ludicrous' });
});

test('pickPreset: a preset valid for the other encoder is rejected (sets are not interchangeable)', () => {
  // 'veryfast' is an x264 preset, invalid for NVENC; 'p6' is an NVENC preset, invalid for x264.
  assert.deepEqual(pickPreset('veryfast', 'h264_nvenc'), { preset: DEFAULT_NVENC_PRESET, rejected: 'veryfast' });
  assert.deepEqual(pickPreset('p6', 'libx264'), { preset: DEFAULT_X264_PRESET, rejected: 'p6' });
});

// --- resolveEncoder: the whole switch (encoder choice + the matching encoder's preset + warnings) ---

test('resolveEncoder: auto + NVENC available → NVENC with its preset, no warnings', () => {
  assert.deepEqual(
    resolveEncoder({ mode: 'auto', nvencSupported: true, nvencPreset: 'p6', x264Preset: 'slow' }),
    { encoder: 'h264_nvenc', preset: 'p6', warnings: [] },
  );
});

test('resolveEncoder: auto + NVENC unavailable → libx264 with the x264 preset, no warnings (silent)', () => {
  assert.deepEqual(
    resolveEncoder({ mode: 'auto', nvencSupported: false, nvencPreset: 'p6', x264Preset: 'slow' }),
    { encoder: 'libx264', preset: 'slow', warnings: [] },
  );
});

test('resolveEncoder: libx264 mode ignores NVENC entirely and reads only the x264 preset', () => {
  assert.deepEqual(
    resolveEncoder({ mode: 'libx264', nvencSupported: true, nvencPreset: 'p6', x264Preset: 'faster' }),
    { encoder: 'libx264', preset: 'faster', warnings: [] },
  );
});

test('resolveEncoder: forced nvenc but unavailable falls back to libx264 AND validates the x264 preset', () => {
  // The cross-interaction: on fallback the *x264* preset is the one that's read/validated, not the
  // NVENC one — even though the NVENC preset here ("p9") is bogus, it is irrelevant once we fall back.
  const r = resolveEncoder({ mode: 'nvenc', nvencSupported: false, nvencPreset: 'p9', x264Preset: 'faster' });
  assert.equal(r.encoder, 'libx264');
  assert.equal(r.preset, 'faster');
  assert.deepEqual(r.warnings, [
    'STUDIO_VIDEO_ENCODER=nvenc but h264_nvenc is unavailable in this ffmpeg build — falling back to libx264',
  ]);
});

test('resolveEncoder: invalid preset for the chosen encoder warns and uses the default', () => {
  const r = resolveEncoder({ mode: 'auto', nvencSupported: true, nvencPreset: 'turbo', x264Preset: 'slow' });
  assert.equal(r.encoder, 'h264_nvenc');
  assert.equal(r.preset, DEFAULT_NVENC_PRESET);
  assert.deepEqual(r.warnings, ['Ignoring invalid NVENC preset "turbo" — using "p5"']);
});

test('resolveEncoder: forced-fallback + an invalid x264 preset aggregates both warnings', () => {
  const r = resolveEncoder({ mode: 'nvenc', nvencSupported: false, nvencPreset: 'p6', x264Preset: 'ludicrous' });
  assert.equal(r.encoder, 'libx264');
  assert.equal(r.preset, DEFAULT_X264_PRESET);
  assert.deepEqual(r.warnings, [
    'STUDIO_VIDEO_ENCODER=nvenc but h264_nvenc is unavailable in this ffmpeg build — falling back to libx264',
    'Ignoring invalid libx264 preset "ludicrous" — using "veryfast"',
  ]);
});

// --- buildVideoArgs: the exact ffmpeg command the switch emits ---

test('buildVideoArgs: NVENC emits CBR args with the preset, no -minrate, bufsize 2x', () => {
  assert.deepEqual(buildVideoArgs('h264_nvenc', 'p5', 4500), [
    '-c:v', 'h264_nvenc',
    '-preset', 'p5',
    '-tune', 'hq',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-rc', 'cbr',
    '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
    '-bf', '2',
    '-r', '30', '-fps_mode', 'cfr', '-g', '60',
  ]);
});

test('buildVideoArgs: libx264 emits CBR args with -minrate and the preset', () => {
  assert.deepEqual(buildVideoArgs('libx264', 'veryfast', 4500), [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', '4500k', '-minrate', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
    '-r', '30', '-fps_mode', 'cfr', '-g', '60',
  ]);
});

test('buildVideoArgs: the configured preset and bitrate flow into the args; bufsize is 2x', () => {
  const args = buildVideoArgs('h264_nvenc', 'p6', 6000);
  assert.deepEqual(args.slice(args.indexOf('-preset'), args.indexOf('-preset') + 2), ['-preset', 'p6']);
  assert.equal(args[args.indexOf('-b:v') + 1], '6000k');
  assert.equal(args[args.indexOf('-maxrate') + 1], '6000k');
  assert.equal(args[args.indexOf('-bufsize') + 1], '12000k');
  // CBR-by-rate-control on NVENC: never the x264-style -minrate.
  assert.ok(!args.includes('-minrate'));
});

test('buildVideoArgs: both encoders pin 30 fps CFR with a 2 s (g=60) keyframe interval', () => {
  for (const enc of ['h264_nvenc', 'libx264'] as const) {
    const args = buildVideoArgs(enc, enc === 'h264_nvenc' ? 'p5' : 'veryfast', 4500);
    assert.equal(args[args.indexOf('-r') + 1], '30');
    assert.equal(args[args.indexOf('-fps_mode') + 1], 'cfr');
    // -g counts FRAMES: 60 = a 2 s interval at 30 fps. Guard against a regression back to 120.
    assert.equal(args[args.indexOf('-g') + 1], '60');
    assert.ok(!args.includes('120'));
  }
});
