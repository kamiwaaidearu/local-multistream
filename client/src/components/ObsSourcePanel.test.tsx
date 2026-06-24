import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { api } from '../lib/api';
import { ObsSourcePanel } from './ObsSourcePanel';

// The panel fetches the real RTMP port + key from the server on mount.
vi.mock('../lib/api', () => ({ api: { getIngestInfo: vi.fn() } }));
const getIngestInfo = vi.mocked(api.getIngestInfo);

function renderPanel(props: { sourceConnected: boolean; sourceType: 'obs' | 'studio' | null }) {
  render(
    <MantineProvider>
      <ObsSourcePanel {...props} />
    </MantineProvider>,
  );
}

beforeEach(() => {
  getIngestInfo.mockReset();
  getIngestInfo.mockResolvedValue({ port: 1935, streamKey: 'multistream-live' });
});

describe('ObsSourcePanel', () => {
  it('shows the real RTMP URL and stream key from the server, not hardcoded values', async () => {
    getIngestInfo.mockResolvedValueOnce({ port: 1936, streamKey: 'rotated-secret-key' });
    renderPanel({ sourceConnected: false, sourceType: null });
    // The configured (non-default) port + key render once the fetch resolves — proving they're
    // sourced from the server, so changing LOCAL_STREAM_KEY can't leave a stale key in the UI.
    expect(await screen.findByText('rtmp://localhost:1936/live')).toBeTruthy();
    expect(screen.getByText('rotated-secret-key')).toBeTruthy();
  });

  it('highlights that OBS is available on the local network only', async () => {
    renderPanel({ sourceConnected: false, sourceType: null });
    await screen.findByText('multistream-live'); // let the fetch settle
    expect(screen.getByText(/local network only/i)).toBeTruthy();
  });

  it('reports "OBS Connected" only when an OBS source is publishing', async () => {
    renderPanel({ sourceConnected: true, sourceType: 'obs' });
    await screen.findByText('multistream-live');
    expect(screen.getByText('OBS Connected')).toBeTruthy();
  });

  it('does not report OBS connected when the Web Studio is the source', async () => {
    renderPanel({ sourceConnected: true, sourceType: 'studio' });
    await screen.findByText('multistream-live');
    expect(screen.getByText('Waiting for OBS...')).toBeTruthy();
    expect(screen.queryByText('OBS Connected')).toBeNull();
  });
});
