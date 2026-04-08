import { Card, Text, Badge, Group, Stack, Button } from '@mantine/core';

const statusColors: Record<string, string> = {
  draft: 'gray',
  ready: 'blue',
  live: 'red',
  ended: 'green',
  error: 'orange',
  pending: 'gray',
  created: 'blue',
  reconnecting: 'yellow',
};

interface PlatformStream {
  id: string;
  platform: string;
  status: string;
  broadcast_id: string | null;
  stream_key: string | null;
  error_message: string | null;
  extra_json: string | null;
}

interface PlatformStatusCardProps {
  platforms: PlatformStream[];
  streamStatus: string;
  onRetry: (platform: string) => void;
  retryingPlatform: string | null;
}

export function PlatformStatusCard({ platforms, streamStatus, onRetry, retryingPlatform }: PlatformStatusCardProps) {
  if (platforms.length === 0) return null;

  return (
    <Card withBorder>
      <Stack>
        <Text fw={500}>Platform Status</Text>
        {platforms.map((ps) => (
          <Group key={ps.id} justify="space-between" wrap="nowrap">
            <Group>
              <Text tt="capitalize" fw={500}>{ps.platform}</Text>
              <Badge color={statusColors[ps.status] ?? 'gray'} size="sm">{ps.status}</Badge>
            </Group>
            <Group>
              {ps.error_message && (
                <Text size="xs" c="red" lineClamp={1}>{ps.error_message}</Text>
              )}
              {ps.status === 'error' && (streamStatus === 'draft' || streamStatus === 'ready') && (
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => onRetry(ps.platform)}
                  loading={retryingPlatform === ps.platform}
                >
                  Retry
                </Button>
              )}
            </Group>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}
