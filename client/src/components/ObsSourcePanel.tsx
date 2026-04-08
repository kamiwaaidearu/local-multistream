import { Card, Stack, Text, Group, Code, CopyButton, ActionIcon, Alert, Badge } from '@mantine/core';

interface ObsSourcePanelProps {
  sourceConnected: boolean;
  sourceType: 'obs' | 'studio' | null;
}

export function ObsSourcePanel({ sourceConnected, sourceType }: ObsSourcePanelProps) {
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>OBS / RTMP Source</Text>
          <Badge color={sourceConnected && sourceType === 'obs' ? 'green' : 'gray'} size="sm">
            {sourceConnected && sourceType === 'obs' ? 'OBS Connected' : 'Waiting for OBS...'}
          </Badge>
        </Group>

        <Group>
          <Text size="sm">Server:</Text>
          <Code>rtmp://localhost:1935/live</Code>
          <CopyButton value="rtmp://localhost:1935/live">
            {({ copy, copied }) => (
              <ActionIcon variant="subtle" onClick={copy} size="sm">
                {copied ? '✓' : '📋'}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>

        <Group>
          <Text size="sm">Stream Key:</Text>
          <Code>multistream-live</Code>
          <CopyButton value="multistream-live">
            {({ copy, copied }) => (
              <ActionIcon variant="subtle" onClick={copy} size="sm">
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
