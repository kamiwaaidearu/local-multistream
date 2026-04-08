import { useState } from 'react';
import { Card, Text, Stack, Timeline, Button, Collapse, Group } from '@mantine/core';

interface EventLogEntry {
  id: number;
  stream_id: string | null;
  platform: string | null;
  event: string;
  detail: string | null;
  ts: number;
}

interface EventLogCardProps {
  events: EventLogEntry[];
}

export function EventLogCard({ events }: EventLogCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) return null;

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={500}>Event Log</Text>
          <Button variant="subtle" size="xs" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : `Show (${events.length})`}
          </Button>
        </Group>
        <Collapse in={expanded}>
          <Timeline active={events.length - 1} bulletSize={16} lineWidth={2}>
            {events.slice(0, 20).map((event) => (
              <Timeline.Item
                key={event.id}
                title={
                  <Text size="xs">
                    {event.platform ? `[${event.platform}] ` : ''}
                    {event.event}
                  </Text>
                }
              >
                {event.detail && <Text size="xs" c="dimmed">{event.detail}</Text>}
                <Text size="xs" c="dimmed">
                  {new Date(event.ts).toLocaleTimeString()}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </Collapse>
      </Stack>
    </Card>
  );
}
