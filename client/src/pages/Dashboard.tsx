import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Title,
  Button,
  Group,
  Text,
  SimpleGrid,
  Tabs,
  Stack,
  Divider,
} from '@mantine/core';
import { useStreams } from '../hooks/useStreams';
import { StreamCard } from '../components/StreamCard';
import { SeriesCreator } from '../components/SeriesCreator';

export function Dashboard() {
  const { streams, refresh } = useStreams();
  const navigate = useNavigate();
  const [seriesOpen, setSeriesOpen] = useState(false);

  const upcoming = streams.filter((s) => s.status !== 'ended');
  const completed = streams.filter((s) => s.status === 'ended');

  // Group by series
  function groupBySeries(list: typeof streams) {
    const standalone: typeof streams = [];
    const seriesMap = new Map<string, typeof streams>();

    for (const s of list) {
      if (s.series_id) {
        const group = seriesMap.get(s.series_id) ?? [];
        group.push(s);
        seriesMap.set(s.series_id, group);
      } else {
        standalone.push(s);
      }
    }

    return { standalone, series: Array.from(seriesMap.entries()) };
  }

  function renderStreamList(list: typeof streams) {
    const { standalone, series } = groupBySeries(list);

    return (
      <Stack>
        {series.map(([seriesId, seriesStreams]) => (
          <Stack key={seriesId} gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Series ({seriesStreams.length} events)
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              {seriesStreams.map((stream) => (
                <StreamCard
                  key={stream.id}
                  stream={stream}
                  onClick={() => navigate(`/streams/${stream.id}`)}
                />
              ))}
            </SimpleGrid>
            <Divider />
          </Stack>
        ))}

        {standalone.length > 0 && (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
            {standalone.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                onClick={() => navigate(`/streams/${stream.id}`)}
              />
            ))}
          </SimpleGrid>
        )}

        {list.length === 0 && (
          <Text c="dimmed">No streams in this category.</Text>
        )}
      </Stack>
    );
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Streams</Title>
        <Group>
          <Button variant="light" onClick={() => setSeriesOpen(true)}>New Series</Button>
          <Button onClick={() => navigate('/streams/new')}>New Stream</Button>
        </Group>
      </Group>

      <Tabs defaultValue="upcoming">
        <Tabs.List>
          <Tabs.Tab value="upcoming">Upcoming ({upcoming.length})</Tabs.Tab>
          <Tabs.Tab value="completed">Completed ({completed.length})</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="upcoming" pt="md">
          {renderStreamList(upcoming)}
        </Tabs.Panel>

        <Tabs.Panel value="completed" pt="md">
          {renderStreamList(completed)}
        </Tabs.Panel>
      </Tabs>

      <SeriesCreator
        opened={seriesOpen}
        onClose={() => setSeriesOpen(false)}
        onCreated={refresh}
      />
    </Stack>
  );
}
