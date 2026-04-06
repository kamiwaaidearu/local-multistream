import { useRef, useEffect } from 'react';
import { Card, Text, Stack, Badge, Group, ScrollArea } from '@mantine/core';
import type { SSEEvent } from '../hooks/useSSE';

interface FFmpegLogProps {
  events: SSEEvent[];
  connected: boolean;
}

export function FFmpegLog({ events, connected }: FFmpegLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>FFmpeg Output</Text>
          <Badge color={connected ? 'green' : 'gray'} size="sm">
            {connected ? 'Connected' : 'Disconnected'}
          </Badge>
        </Group>
        <ScrollArea h={200} viewportRef={scrollRef}>
          <Stack gap={2}>
            {events.length === 0 && (
              <Text size="xs" c="dimmed">Waiting for FFmpeg output...</Text>
            )}
            {events.map((event, i) => (
              <Text
                key={i}
                size="xs"
                ff="monospace"
                c={
                  event.type === 'ffmpeg_crash' || event.type === 'ffmpeg_gave_up'
                    ? 'red'
                    : event.type === 'ffmpeg_reconnecting'
                    ? 'yellow'
                    : event.type === 'ffmpeg_started' || event.type === 'ffmpeg_stopped'
                    ? 'blue'
                    : 'dimmed'
                }
              >
                [{event.platform ?? 'system'}] {event.type}
                {event.data ? `: ${event.data}` : ''}
                {event.retryIn ? ` (retry in ${event.retryIn}s)` : ''}
              </Text>
            ))}
          </Stack>
        </ScrollArea>
      </Stack>
    </Card>
  );
}
