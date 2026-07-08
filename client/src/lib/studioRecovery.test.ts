import { describe, it, expect } from 'vitest';
import { shouldShowStudioReconnect } from './studioRecovery';

describe('shouldShowStudioReconnect', () => {
  it('shows when live via Studio and the transport dropped (disconnected or error)', () => {
    expect(shouldShowStudioReconnect('live', 'studio', 'disconnected')).toBe(true);
    expect(shouldShowStudioReconnect('live', 'studio', 'error')).toBe(true);
  });

  it('stays hidden while connected or a reconnect is already in flight', () => {
    expect(shouldShowStudioReconnect('live', 'studio', 'connected')).toBe(false);
    expect(shouldShowStudioReconnect('live', 'studio', 'connecting')).toBe(false);
  });

  it('never shows outside a live stream', () => {
    for (const status of ['draft', 'ready', 'ended', 'error']) {
      expect(shouldShowStudioReconnect(status, 'studio', 'disconnected')).toBe(false);
    }
  });

  it('never shows for OBS mode (OBS publishes independently of this tab)', () => {
    expect(shouldShowStudioReconnect('live', 'obs', 'disconnected')).toBe(false);
  });
});
