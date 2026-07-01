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
  // Live recovery (only used while the stream is live).
  onReconnect?: (platform: string) => void;
  onRetryLive?: (platform: string) => void;
  reconnectingPlatform?: string | null;
  retryingLivePlatform?: string | null;
}

export function PlatformStatusCard({
  platforms,
  streamStatus,
  onRetry,
  retryingPlatform,
  onReconnect,
  onRetryLive,
  reconnectingPlatform,
  retryingLivePlatform,
}: PlatformStatusCardProps) {
  if (platforms.length === 0) return null;

  const isLive = streamStatus === 'live';

  return (
    <Card withBorder>
      <Stack>
        <Text fw={500}>Platform Status</Text>
        {platforms.map((ps) => {
          // While live, a platform that isn't confirmed 'live' (errored, reconnecting, or never
          // transitioned — e.g. YouTube on a dead token) can be recovered in place.
          const needsLiveRecovery = isLive && ps.status !== 'live';
          return (
            <Group key={ps.id} justify="space-between" wrap="nowrap">
              <Group>
                <Text tt="capitalize" fw={500}>{ps.platform}</Text>
                <Badge color={statusColors[ps.status] ?? 'gray'} size="sm">{ps.status}</Badge>
              </Group>
              <Group gap="xs">
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
                {needsLiveRecovery && onReconnect && (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => onReconnect(ps.platform)}
                    loading={reconnectingPlatform === ps.platform}
                  >
                    Reconnect
                  </Button>
                )}
                {needsLiveRecovery && onRetryLive && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    onClick={() => onRetryLive(ps.platform)}
                    loading={retryingLivePlatform === ps.platform}
                  >
                    Retry go-live
                  </Button>
                )}
              </Group>
            </Group>
          );
        })}
      </Stack>
    </Card>
  );
}
