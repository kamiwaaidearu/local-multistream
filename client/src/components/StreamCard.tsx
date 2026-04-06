import { Card, Text, Badge, Group, Image } from '@mantine/core';

interface StreamCardProps {
  stream: {
    id: string;
    name: string;
    thumbnail_path: string | null;
    scheduled_start: number | null;
    status: string;
    series_id: string | null;
  };
  onClick: () => void;
}

const statusColors: Record<string, string> = {
  draft: 'gray',
  ready: 'blue',
  live: 'red',
  ended: 'green',
  error: 'orange',
};

export function StreamCard({ stream, onClick }: StreamCardProps) {
  const date = stream.scheduled_start
    ? new Date(stream.scheduled_start * 1000).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'No date set';

  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder onClick={onClick} style={{ cursor: 'pointer' }}>
      {stream.thumbnail_path && (
        <Card.Section>
          <Image src={stream.thumbnail_path} height={160} alt={stream.name} />
        </Card.Section>
      )}
      <Group justify="space-between" mt="md" mb="xs">
        <Text fw={500} lineClamp={1}>{stream.name}</Text>
        <Badge color={statusColors[stream.status] ?? 'gray'}>{stream.status}</Badge>
      </Group>
      <Text size="sm" c="dimmed">{date}</Text>
    </Card>
  );
}
