import { useEffect, useState } from 'react';
import { Card, Stack, Text, Group, Code, CopyButton, ActionIcon, Alert, Badge } from '@mantine/core';
import { api } from '../lib/api';

interface ObsSourcePanelProps {
  sourceConnected: boolean;
  sourceType: 'obs' | 'studio' | null;
}

export function ObsSourcePanel({ sourceConnected, sourceType }: ObsSourcePanelProps) {
  // Pull the real RTMP port + stream key from the server (RTMP_PORT / LOCAL_STREAM_KEY) rather than
  // hardcoding them, so the panel always shows what OBS must actually use — and never drifts (and
  // silently fails go-live) if the operator changes the stream key.
  const [ingest, setIngest] = useState<{ port: number; streamKey: string } | null>(null);
  useEffect(() => {
    api.getIngestInfo().then(setIngest).catch(() => {});
  }, []);

  const serverUrl = ingest ? `rtmp://localhost:${ingest.port}/live` : '';
  const obsConnected = sourceConnected && sourceType === 'obs';

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>OBS / RTMP Source</Text>
          <Badge color={obsConnected ? 'green' : 'gray'} size="sm">
            {obsConnected ? 'OBS Connected' : 'Waiting for OBS...'}
          </Badge>
        </Group>

        {/* OBS is local-only: the Cloudflare Tunnel carries the web app, not RTMP. */}
        <Alert color="yellow" variant="light" title="Available on your local network only">
          OBS must run on this computer or another device on the same local network. The public
          tunnel address only carries the web app, not RTMP, so OBS can&apos;t be used remotely yet —
          use the Web Studio for remote streaming. From another computer on your LAN, replace{' '}
          <Code>localhost</Code> with this PC&apos;s local IP (e.g. 192.168.x.x).
        </Alert>

        <Group>
          <Text size="sm">Server:</Text>
          <Code>{serverUrl || 'loading…'}</Code>
          <CopyButton value={serverUrl}>
            {({ copy, copied }) => (
              <ActionIcon variant="subtle" onClick={copy} size="sm" disabled={!serverUrl}>
                {copied ? '✓' : '📋'}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>

        <Group>
          <Text size="sm">Stream Key:</Text>
          <Code>{ingest?.streamKey || 'loading…'}</Code>
          <CopyButton value={ingest?.streamKey ?? ''}>
            {({ copy, copied }) => (
              <ActionIcon variant="subtle" onClick={copy} size="sm" disabled={!ingest}>
                {copied ? '✓' : '📋'}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>

        <Alert title="Recommended OBS Settings" variant="light">
          1080p, 4500-6000 kbps, H.264, CBR, Keyframe Interval: 2s, 30fps
        </Alert>
      </Stack>
    </Card>
  );
}
