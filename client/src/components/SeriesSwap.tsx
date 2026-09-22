import { useEffect, useState } from 'react';
import {
  Modal,
  Stack,
  Group,
  Text,
  Card,
  Image,
  Button,
  Badge,
  Alert,
  SimpleGrid,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';
import type { Stream } from '../hooks/useStreams';

/** Mirrors the server's rule (server/stream/swapPolicy.ts): only unaired events may be swapped. */
const SWAPPABLE_STATUSES = ['draft', 'ready'];

function formatSlot(scheduledStart: number | null): string {
  if (!scheduledStart) return 'No date set';
  return new Date(scheduledStart * 1000).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

interface SeriesSwapProps {
  opened: boolean;
  onClose: () => void;
  /** The events of one series. Non-swappable ones are shown as locked rather than hidden. */
  streams: Stream[];
  onSwapped: () => void;
}

/**
 * Trade the content of two events in a series without moving either one.
 *
 * The operator picks two events; their titles, descriptions and thumbnails change places while the
 * dates, the destinations and the announcement schedule stay attached to the slot. Picking is
 * visual (click the cards) because the thumbnail is usually what tells the two events apart.
 */
export function SeriesSwap({ opened, onClose, streams, onSwapped }: SeriesSwapProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Start clean each time it opens, so a previous selection can't be confirmed by accident.
  useEffect(() => { if (opened) setPicked([]); }, [opened]);

  const ordered = [...streams].sort((x, y) => (x.scheduled_start ?? 0) - (y.scheduled_start ?? 0));
  const lockedCount = ordered.filter((s) => !SWAPPABLE_STATUSES.includes(s.status)).length;

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      // Already holding two? Drop the older pick so a third click just re-aims the swap.
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  }

  const a = ordered.find((s) => s.id === picked[0]);
  const b = ordered.find((s) => s.id === picked[1]);

  async function handleSwap() {
    if (!a || !b) return;
    setSaving(true);
    try {
      const res = await api.swapStreams(a.id, b.id);
      const warnings = res.sync_warnings ?? [];
      notifications.show({
        title: 'Events swapped',
        message: warnings.length
          ? `Saved, but ${warnings.length} destination update needs a look.`
          : 'Titles, descriptions and thumbnails traded places. Dates unchanged.',
        color: warnings.length ? 'yellow' : 'green',
      });
      // Each warning names a destination that didn't take the change — these must not auto-dismiss,
      // since they mean the platform still shows the old content.
      for (const w of warnings) {
        notifications.show({ title: 'Destination not updated', message: w, color: 'yellow', autoClose: false });
      }
      onSwapped();
      onClose();
    } catch (err) {
      notifications.show({ title: 'Swap failed', message: String(err), color: 'red', autoClose: false });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Swap two events" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Pick two events. Their title, description and thumbnail trade places — the dates,
          the YouTube/Facebook/Twitch destinations and the scheduled Facebook posts stay with
          their slot and are updated to match the new content.
        </Text>

        {lockedCount > 0 && (
          <Alert color="gray">
            {lockedCount} event{lockedCount === 1 ? ' is' : 's are'} already live or finished and
            can&apos;t be swapped.
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {ordered.map((s) => {
            const locked = !SWAPPABLE_STATUSES.includes(s.status);
            const index = picked.indexOf(s.id);
            return (
              <Card
                key={s.id}
                withBorder
                padding="sm"
                onClick={() => !locked && toggle(s.id)}
                style={{
                  cursor: locked ? 'not-allowed' : 'pointer',
                  opacity: locked ? 0.5 : 1,
                  borderColor: index >= 0 ? 'var(--mantine-color-blue-6)' : undefined,
                  borderWidth: index >= 0 ? 2 : undefined,
                }}
              >
                <Group justify="space-between" mb={4} wrap="nowrap">
                  <Text size="xs" c="dimmed">{formatSlot(s.scheduled_start)}</Text>
                  {index >= 0 && <Badge size="sm">{index === 0 ? 'First' : 'Second'}</Badge>}
                  {locked && <Badge size="sm" color="gray">{s.status}</Badge>}
                </Group>
                {s.thumbnail_path && (
                  <Image src={s.thumbnail_path} height={90} fit="cover" alt="" radius="sm" mb={6} />
                )}
                <Text size="sm" fw={500} lineClamp={2}>{s.name}</Text>
              </Card>
            );
          })}
        </SimpleGrid>

        {a && b && (
          <Alert color="blue" title="After the swap">
            <Stack gap={2}>
              <Text size="sm">{formatSlot(a.scheduled_start)} → &ldquo;{b.name}&rdquo;</Text>
              <Text size="sm">{formatSlot(b.scheduled_start)} → &ldquo;{a.name}&rdquo;</Text>
            </Stack>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSwap} loading={saving} disabled={!a || !b}>
            Swap content
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
