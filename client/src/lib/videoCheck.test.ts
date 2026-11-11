import { describe, it, expect } from 'vitest';
import { classifyVideoSource, isVideoReady, maxLumaOf, BLACK_MAX_LUMA, type VideoSample } from './videoCheck';

const live: VideoSample = { enabled: true, inLayout: true, readyState: 4, videoWidth: 1280, maxLuma: 200 };

describe('classifyVideoSource', () => {
  it('is off when not enabled, whatever else is true', () => {
    expect(classifyVideoSource({ ...live, enabled: false })).toBe('off');
  });

  it('flags a source missing from the layout', () => {
    expect(classifyVideoSource({ ...live, inLayout: false })).toBe('not_in_layout');
  });

  it('waits until frames arrive', () => {
    expect(classifyVideoSource({ ...live, readyState: 1 })).toBe('waiting');
    expect(classifyVideoSource({ ...live, videoWidth: 0 })).toBe('waiting');
    expect(classifyVideoSource({ ...live, maxLuma: null })).toBe('waiting');
  });

  it('flags a black picture (closed shutter)', () => {
    expect(classifyVideoSource({ ...live, maxLuma: 3 })).toBe('black');
    expect(classifyVideoSource({ ...live, maxLuma: BLACK_MAX_LUMA - 1 })).toBe('black');
  });

  it('accepts a dim but real picture', () => {
    expect(classifyVideoSource({ ...live, maxLuma: BLACK_MAX_LUMA })).toBe('ok');
  });
});

describe('isVideoReady', () => {
  it('needs both camera and slides showing a picture', () => {
    expect(isVideoReady({ camera: 'off', slides: 'off' })).toBe(false);
    expect(isVideoReady({ camera: 'ok', slides: 'off' })).toBe(false);
    expect(isVideoReady({ camera: 'off', slides: 'ok' })).toBe(false);
    expect(isVideoReady({ camera: 'black', slides: 'ok' })).toBe(false);
    expect(isVideoReady({ camera: 'ok', slides: 'waiting' })).toBe(false);
    expect(isVideoReady({ camera: 'ok', slides: 'ok' })).toBe(true);
  });
});

describe('maxLumaOf', () => {
  it('returns the brightest pixel', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 10, 10, 10, 255]);
    expect(Math.round(maxLumaOf(px))).toBe(255);
  });

  it('is 0 for an all-black frame', () => {
    expect(maxLumaOf(new Uint8ClampedArray(4 * 16))).toBe(0);
  });
});
