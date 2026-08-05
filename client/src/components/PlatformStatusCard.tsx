import { Card, Text, Badge, Group, Stack, Button, Alert } from '@mantine/core';

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

/** Per-platform ingest health — what the PLATFORM says it is receiving (see server healthMonitor). */
interface PlatformIngestHealth {
  state: 'unknown' | 'healthy' | 'degraded' | 'not_receiving';
  reason: string;
  videoKbps: number | null;
  pushKbps: number | null;
  fps: number | null;
  warnings: string[];
  alarm: boolean;
}

const healthLabels: Record<PlatformIngestHealth['state'], { color: string; label: string }> = {
  healthy: { color: 'green', label: 'receiving' },
  degraded: { color: 'yellow', label: 'receiving (warnings)' },
  not_receiving: { color: 'red', label: 'NOT receiving' },
  unknown: { color: 'gray', label: 'checking…' },
};

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
  /** Keyed by platform. Our leg being alive is NOT the same as the platform receiving video — this is
   *  the difference, and it's the signal that was missing on 2026-08-05. */
  health?: Record<string, PlatformIngestHealth>;
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
  health,
}: PlatformStatusCardProps) {
  if (platforms.length === 0) return null;

  const isLive = streamStatus === 'live';
  // Platforms the server's health monitor has given up on. Surfaced at the top of the card, because a
  // leg that is "live" by our reckoning while the platform receives nothing is the exact failure that
  // went unnoticed for 24 minutes on 2026-08-05.
  const alarming = Object.entries(health ?? {}).filter(([, h]) => h.alarm || h.state === 'not_receiving');

  return (
    <Card withBorder>
      <Stack>
        <Text fw={500}>Platform Status</Text>

        {isLive && alarming.length > 0 && (
          <Alert color="red" title="A platform is not receiving your video">
            <Stack gap={4}>
              {alarming.map(([platform, h]) => (
                <Text key={platform} size="sm">
                  <Text span tt="capitalize" fw={600}>{platform}</Text>: {h.reason}
                  {h.pushKbps !== null && ` — we're sending ${h.pushKbps} kbps`}
                </Text>
              ))}
              <Text size="xs" c="dimmed">
                We are pushing video, but the platform reports it isn't arriving. The leg is restarted
                automatically a couple of times; if that hasn't helped, use Retry go-live below, or
                recreate the broadcast on that platform.
              </Text>
            </Stack>
          </Alert>
        )}

        {platforms.map((ps) => {
          // While live, a platform that isn't confirmed 'live' (errored, reconnecting, or never
          // transitioned — e.g. YouTube on a dead token) can be recovered in place.
          const needsLiveRecovery = isLive && ps.status !== 'live';
          return (
            <Group key={ps.id} justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <Text tt="capitalize" fw={500}>{ps.platform}</Text>
                <Badge color={statusColors[ps.status] ?? 'gray'} size="sm">{ps.status}</Badge>
                {/* The platform's own verdict, kept visually distinct from OUR leg status above. */}
                {isLive && health?.[ps.platform] && (
                  <Badge
                    color={healthLabels[health[ps.platform].state].color}
                    size="sm"
                    variant="outline"
                    title={health[ps.platform].reason}
                  >
                    {healthLabels[health[ps.platform].state].label}
                    {health[ps.platform].videoKbps !== null && ` · ${health[ps.platform].videoKbps} kbps`}
                  </Badge>
                )}
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
