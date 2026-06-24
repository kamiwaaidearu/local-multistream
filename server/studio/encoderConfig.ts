// Pure encoder/preset decision logic for the Web Studio ingest, split out from ingest.ts so it can
// be unit-tested without spawning ffmpeg or needing a GPU. ingest.ts wires these to the real
// config, the NVENC probe, and logging.

export type VideoEncoder = 'h264_nvenc' | 'libx264';

// The valid STUDIO_VIDEO_ENCODER values — single source of truth for both the runtime allow-list
// (config.ts) and the EncoderMode type, so the two can't drift.
export const ENCODER_MODES = ['auto', 'nvenc', 'libx264'] as const;
export type EncoderMode = typeof ENCODER_MODES[number];

// Default preset per encoder. Single source of truth: used as the env fallback in config.ts AND as
// the fallback when a configured preset is invalid.
export const DEFAULT_NVENC_PRESET = 'p5';
export const DEFAULT_X264_PRESET = 'veryfast';

// Valid presets per encoder (from `ffmpeg -h encoder=h264_nvenc` / libx264's documented set). An
// unknown value — a typo, or a preset this build doesn't ship — falls back to the default rather
// than failing the ingest: a config typo must never break streaming.
export const NVENC_PRESETS = new Set([
  'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7',
  'default', 'slow', 'medium', 'fast', 'hp', 'hq', 'bd', 'll', 'llhq', 'llhp', 'lossless', 'losslesshp',
]);
export const X264_PRESETS = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo',
]);

export interface EncoderChoice {
  encoder: VideoEncoder;
  // True only when STUDIO_VIDEO_ENCODER=nvenc was requested but NVENC isn't available, so we fell
  // back to libx264 — the caller should warn. ('auto' falls back silently.)
  forcedNvencUnavailable: boolean;
}

// Decide the encoder from the configured mode + whether NVENC is actually supported. NVENC always
// falls back to libx264 when unsupported so streaming never breaks.
export function selectEncoder(mode: EncoderMode, nvencSupported: boolean): EncoderChoice {
  if (mode === 'libx264') return { encoder: 'libx264', forcedNvencUnavailable: false };
  if (nvencSupported) return { encoder: 'h264_nvenc', forcedNvencUnavailable: false };
  return { encoder: 'libx264', forcedNvencUnavailable: mode === 'nvenc' };
}

export interface PresetChoice {
  preset: string;
  // The original value when it was rejected as invalid (caller should warn), else null. An empty /
  // unset value is NOT "rejected" — it just uses the default silently.
  rejected: string | null;
}

// Normalize (trim + lowercase) and validate a configured preset for the given encoder, falling back
// to the default on an empty or unknown value.
export function pickPreset(configured: string, encoder: VideoEncoder): PresetChoice {
  const valid = encoder === 'h264_nvenc' ? NVENC_PRESETS : X264_PRESETS;
  const fallback = encoder === 'h264_nvenc' ? DEFAULT_NVENC_PRESET : DEFAULT_X264_PRESET;
  const value = configured.trim().toLowerCase();
  if (!value) return { preset: fallback, rejected: null };
  if (valid.has(value)) return { preset: value, rejected: null };
  return { preset: fallback, rejected: configured };
}

export interface ResolveInput {
  mode: EncoderMode;
  nvencSupported: boolean;
  nvencPreset: string;
  x264Preset: string;
}
export interface ResolveResult {
  encoder: VideoEncoder;
  preset: string;
  // Operator-facing messages the caller should log (prefix-free). Empty when nothing was off.
  warnings: string[];
}

// The whole ingest encoder decision, as one pure function: pick the encoder, then validate the
// preset belonging to the *resolved* encoder (so a forced-NVENC fallback validates the x264 preset,
// not the NVENC one). Returns any warnings instead of logging, so it's side-effect free.
export function resolveEncoder(input: ResolveInput): ResolveResult {
  const warnings: string[] = [];

  const { encoder, forcedNvencUnavailable } = selectEncoder(input.mode, input.nvencSupported);
  if (forcedNvencUnavailable) {
    warnings.push('STUDIO_VIDEO_ENCODER=nvenc but h264_nvenc is unavailable in this ffmpeg build — falling back to libx264');
  }

  const configuredPreset = encoder === 'h264_nvenc' ? input.nvencPreset : input.x264Preset;
  const { preset, rejected } = pickPreset(configuredPreset, encoder);
  if (rejected !== null) {
    warnings.push(`Ignoring invalid ${encoder === 'h264_nvenc' ? 'NVENC' : 'libx264'} preset "${rejected}" — using "${preset}"`);
  }

  return { encoder, preset, warnings };
}

// Build the video-encoder portion of the ingest ffmpeg args for the resolved encoder + preset.
// Constant bitrate so the encoder actually spends the budget (sharp image) rather than
// undershooting on low-motion slides. We don't chase minimal latency (no -tune zerolatency /
// nvenc ll) — it disables b-frames and lookahead, which hurts quality, and a second or two of
// extra latency is fine for a one-way broadcast.
export function buildVideoArgs(encoder: VideoEncoder, preset: string, videoBitrateKbps: number): string[] {
  const vb = `${videoBitrateKbps}k`;
  const bufsize = `${videoBitrateKbps * 2}k`;

  // Normalize the output to a steady 30 fps CFR with a 2 s keyframe interval (applied to both
  // encoders). The browser compositor emits ~30 fps but with jitter; platforms want a constant
  // rate, so -r 30 + -fps_mode cfr (ffmpeg ≥ 5.1) pin CFR by duplicating/dropping to hit exactly
  // 30. -g counts FRAMES, so a 2 s interval at 30 fps is 60 (rule: g = 2 × fps) — not 120.
  const fps = ['-r', '30', '-fps_mode', 'cfr', '-g', '60'];

  if (encoder === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      // Preset (speed↔quality) is STUDIO_NVENC_PRESET; p5 + '-tune hq' comfortably beats libx264
      // veryfast and the GPU has headroom (p1=fastest … p7=best).
      '-preset', preset,
      '-tune', 'hq',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      // NVENC constant bitrate: -rc cbr with maxrate == target and a ~2x VBV buffer. (No -minrate;
      // nvenc's cbr mode already holds the rate, unlike x264's VBV below.)
      '-rc', 'cbr',
      '-b:v', vb, '-maxrate', vb, '-bufsize', bufsize,
      '-bf', '2',
      ...fps,
    ];
  }
  return [
    '-c:v', 'libx264',
    // Preset (speed↔quality) is STUDIO_X264_PRESET; default veryfast.
    '-preset', preset,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', vb, '-minrate', vb, '-maxrate', vb, '-bufsize', bufsize,
    ...fps,
  ];
}
