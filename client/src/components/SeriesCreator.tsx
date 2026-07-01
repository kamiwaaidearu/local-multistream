import { useState } from 'react';
import {
  Modal,
  TextInput,
  Textarea,
  NumberInput,
  Button,
  Stack,
  Group,
  Text,
  FileInput,
  Card,
  ScrollArea,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';

interface SeriesCreatorProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface StreamEntry {
  name: string;
  description: string;
  thumbnail: File | null;
  scheduled_start: Date | null;
}

export function SeriesCreator({ opened, onClose, onCreated }: SeriesCreatorProps) {
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [count, setCount] = useState<number | ''>(4);
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [saving, setSaving] = useState(false);

  function generateSlots() {
    if (!startDate || !count) return;
    const slots: StreamEntry[] = [];
    for (let i = 0; i < count; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i * 7);
      slots.push({
        name: '',
        description: '',
        thumbnail: null,
        scheduled_start: date,
      });
    }
    setEntries(slots);
  }

  function updateEntry(index: number, field: keyof StreamEntry, value: unknown) {
    setEntries((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  async function handleCreateAll() {
    if (entries.some((e) => !e.name.trim())) {
      notifications.show({ title: 'Error', message: 'All streams need a name', color: 'red' });
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      const streamsJson = entries.map((e) => ({
        name: e.name,
        description: e.description || undefined,
        scheduled_start: e.scheduled_start ? Math.floor(e.scheduled_start.getTime() / 1000) : undefined,
      }));
      formData.append('streams', JSON.stringify(streamsJson));

      // Only append real images (empty-blob padding trips the server's JPEG/PNG filter). A parallel
      // index array tells the server which entry each uploaded file belongs to, in append order.
      const thumbnailIndices: number[] = [];
      entries.forEach((e, i) => {
        if (e.thumbnail) {
          formData.append('thumbnails', e.thumbnail);
          thumbnailIndices.push(i);
        }
      });
      formData.append('thumbnail_indices', JSON.stringify(thumbnailIndices));

      await api.createSeries(formData);
      notifications.show({ title: 'Success', message: `Created ${entries.length} streams`, color: 'green' });
      onCreated();
      onClose();
      setEntries([]);
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New Series" size="xl">
      <Stack>
        {entries.length === 0 ? (
          <>
            <DateTimePicker
              label="First event date"
              value={startDate}
              onChange={setStartDate}
              required
            />
            <NumberInput
              label="Number of weeks"
              min={2}
              max={20}
              value={count}
              onChange={(v) => setCount(v as number)}
              required
            />
            <Button onClick={generateSlots} disabled={!startDate || !count}>
              Generate {count || 0} Weekly Slots
            </Button>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">{entries.length} events (weekly recurrence)</Text>
            <ScrollArea h={400}>
              <Stack>
                {entries.map((entry, i) => (
                  <Card key={i} withBorder padding="sm">
                    <Stack gap="xs">
                      <Group justify="space-between">
                        <Text fw={500} size="sm">
                          Event {i + 1} — {entry.scheduled_start?.toLocaleDateString(undefined, {
                            weekday: 'short', month: 'short', day: 'numeric',
                          })}
                        </Text>
                      </Group>
                      <TextInput
                        label="Title"
                        placeholder={`Week ${i + 1} title`}
                        required
                        value={entry.name}
                        onChange={(e) => updateEntry(i, 'name', e.currentTarget.value)}
                        size="xs"
                      />
                      <Textarea
                        label="Description"
                        placeholder="Optional description"
                        value={entry.description}
                        onChange={(e) => updateEntry(i, 'description', e.currentTarget.value)}
                        size="xs"
                        minRows={1}
                      />
                      <FileInput
                        label="Thumbnail"
                        accept="image/jpeg,image/png"
                        value={entry.thumbnail}
                        onChange={(file) => updateEntry(i, 'thumbnail', file)}
                        size="xs"
                      />
                    </Stack>
                  </Card>
                ))}
              </Stack>
            </ScrollArea>
            <Group justify="space-between">
              <Button variant="subtle" onClick={() => setEntries([])}>
                Back
              </Button>
              <Button onClick={handleCreateAll} loading={saving}>
                Create All ({entries.length} Streams)
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
