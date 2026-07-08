import { describe, it, expect } from 'vitest';
import { recommendQuality, computeMbps, MIN_VIABLE_MBPS, QUALITY_PRESETS, DEFAULT_QUALITY, type ProbeSample } from './bandwidthProbe';

describe('recommendQuality', () => {
  // Thresholds derive from each preset's (video + 0.16 audio) total × 1.6 headroom:
  // high ≈ 10.66 Mbps, medium ≈ 7.46 Mbps, low below that.
  it('recommends high only with ~1.6x headroom over the 6.5 Mbps preset', () => {
    expect(recommendQuality(11)).toBe('high');
    expect(recommendQuality(50)).toBe('high');
    expect(recommendQuality(10.5)).toBe('medium'); // just below the high threshold
  });

  it('recommends medium with ~1.6x headroom over the 4.5 Mbps preset', () => {
    expect(recommendQuality(8)).toBe('medium');
    expect(recommendQuality(7.5)).toBe('medium');
    expect(recommendQuality(7)).toBe('low'); // just below the medium threshold
  });

  it('recommends low below the medium threshold, including zero', () => {
    expect(recommendQuality(0)).toBe('low');
    expect(recommendQuality(5)).toBe('low');
    expect(recommendQuality(7.4)).toBe('low');
  });

  it('always returns a key that exists in QUALITY_PRESETS', () => {
    for (const mbps of [0, 5, 8, 11, 100]) {
      expect(QUALITY_PRESETS[recommendQuality(mbps)]).toBeDefined();
    }
  });

  it('exposes MIN_VIABLE_MBPS as a positive floor below which low is still the pick', () => {
    expect(MIN_VIABLE_MBPS).toBeGreaterThan(0);
    expect(recommendQuality(MIN_VIABLE_MBPS - 0.5)).toBe('low');
  });
});

describe('QUALITY_PRESETS', () => {
  it('each entry key matches its map key', () => {
    for (const [key, preset] of Object.entries(QUALITY_PRESETS)) {
      expect(preset.key).toBe(key);
    }
  });

  it('bitrates increase from low to high', () => {
    expect(QUALITY_PRESETS.low.videoBps).toBeLessThan(QUALITY_PRESETS.medium.videoBps);
    expect(QUALITY_PRESETS.medium.videoBps).toBeLessThan(QUALITY_PRESETS.high.videoBps);
  });
});

describe('DEFAULT_QUALITY', () => {
  it('defaults to the lowest preset so an unmeasured connection cannot over-commit', () => {
    expect(DEFAULT_QUALITY).toBe('low');
    // Nothing should sit below the default — it must be the floor.
    expect(QUALITY_PRESETS[DEFAULT_QUALITY].videoBps).toBe(
      Math.min(...Object.values(QUALITY_PRESETS).map((p) => p.videoBps)),
    );
  });

  it('is a valid preset key', () => {
    expect(QUALITY_PRESETS[DEFAULT_QUALITY]).toBeDefined();
  });
});

describe('computeMbps', () => {
  const startTs = 1000;
  const warmupMs = 1000; // warm-up ends at t = 2000

  it('computes throughput across the steady-state window, discarding warm-up', () => {
    const samples: ProbeSample[] = [
      { bytes: 0, t: 1000 }, // warm-up (dropped)
      { bytes: 1_000_000, t: 1500 }, // warm-up (dropped)
      { bytes: 2_000_000, t: 2000 }, // first usable
      { bytes: 4_000_000, t: 4000 }, // last usable: +2,000,000 bytes over 2s
    ];
    // 2,000,000 bytes * 8 / 2s = 8,000,000 bps = 8 Mbps
    expect(computeMbps(samples, startTs, warmupMs)).toBeCloseTo(8, 5);
  });

  it('returns null when there are fewer than two samples', () => {
    expect(computeMbps([], startTs, warmupMs)).toBeNull();
    expect(computeMbps([{ bytes: 100, t: 3000 }], startTs, warmupMs)).toBeNull();
  });

  it('falls back to the full series when warm-up leaves fewer than two samples', () => {
    // Both samples sit inside the warm-up window — compute from them rather than failing.
    const samples: ProbeSample[] = [
      { bytes: 0, t: 1000 },
      { bytes: 1_250_000, t: 1500 }, // +1,250,000 bytes over 0.5s = 20 Mbps
    ];
    expect(computeMbps(samples, startTs, warmupMs)).toBeCloseTo(20, 5);
  });

  it('returns null when elapsed time is zero (no divide-by-zero)', () => {
    const samples: ProbeSample[] = [
      { bytes: 1_000_000, t: 3000 },
      { bytes: 2_000_000, t: 3000 }, // identical timestamp
    ];
    expect(computeMbps(samples, startTs, warmupMs)).toBeNull();
  });

  it('clamps to zero rather than going negative if byte counts regress', () => {
    const samples: ProbeSample[] = [
      { bytes: 5_000_000, t: 2000 },
      { bytes: 4_000_000, t: 4000 }, // went backwards
    ];
    expect(computeMbps(samples, startTs, warmupMs)).toBe(0);
  });
});
