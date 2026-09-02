import { useEffect, useState } from 'react';
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
  Select,
  Badge,
  Alert,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';
import { useThumbnailTemplates } from '../hooks/useThumbnailTemplates';
import { ThumbnailPreview } from './ThumbnailPreview';
import { ThumbnailStudio } from './ThumbnailStudio';
import { loadPlate, renderThumbnailFile, thumbnailFilename } from '../lib/thumbnailTemplate';

/**
 * Renders a local File as an image, revoking its object URL on unmount.
 *
 * Inlining `URL.createObjectURL` in the JSX would mint a fresh, never-revoked URL on every render —
 * and this modal re-renders on every keystroke across every week's title field.
 */
function FilePreview({ file, width }: { file: File; width: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  if (!url) return null;
  return <img src={url} alt="" style={{ width, borderRadius: 4, display: 'block' }} />;
}

interface SeriesCreatorProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface StreamEntry {
  name: string;
  description: string;
  /** A manually uploaded or hand-edited image. When set it wins over the template. */
  thumbnail: File | null;
  /** Template to render this week's thumbnail from. Null means "no thumbnail". */
  templateId: string | null;
  scheduled_start: Date | null;
}

export function SeriesCreator({ opened, onClose, onCreated }: SeriesCreatorProps) {
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [count, setCount] = useState<number | ''>(4);
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const { templates, ready: thumbnailsReady } = useThumbnailTemplates(opened);

  useEffect(() => {
    if (!defaultTemplateId && templates.length > 0) setDefaultTemplateId(templates[0].id);
  }, [templates, defaultTemplateId]);

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
        templateId: defaultTemplateId,
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

  /**
   * Renders one JPEG per entry that has a template and no manual upload.
   *
   * Plates are decoded once per template rather than per entry — a four-week series on one template
   * would otherwise decode the same 2MB photograph four times.
   */
  async function renderEntryThumbnails(): Promise<Map<number, File>> {
    const out = new Map<number, File>();
    const plateCache = new Map<string, CanvasImageSource | null>();

    for (const [i, entry] of entries.entries()) {
      if (entry.thumbnail) {
        out.set(i, entry.thumbnail);
        continue;
      }
      const stored = templates.find((t) => t.id === entry.templateId);
      if (!stored) continue;

      const plateKey = stored.config.plate ?? '';
      if (!plateCache.has(plateKey)) plateCache.set(plateKey, await loadPlate(stored.config.plate));

      out.set(
        i,
        await renderThumbnailFile(
          stored.config,
          { title: entry.name, date: entry.scheduled_start },
          plateCache.get(plateKey) ?? null,
          thumbnailFilename(entry.name),
        ),
      );
    }
    return out;
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
      const thumbnails = await renderEntryThumbnails();
      const thumbnailIndices: number[] = [];
      for (const [index, file] of [...thumbnails.entries()].sort((a, b) => a[0] - b[0])) {
        formData.append('thumbnails', file);
        thumbnailIndices.push(index);
      }
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

  const templateOptions = templates.map((t) => ({ value: t.id, label: t.name }));
  const editing = editingIndex !== null ? entries[editingIndex] : null;
  const missingPlate = templates.some((t) => entries.some((e) => e.templateId === t.id) && !t.config.plate);

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
            <Select
              label="Thumbnail template"
              description="Applied to every week. Any single week can be switched to another template afterwards."
              data={templateOptions}
              value={defaultTemplateId}
              onChange={setDefaultTemplateId}
              placeholder="No thumbnails"
              clearable
            />
            <Button onClick={generateSlots} disabled={!startDate || !count}>
              Generate {count || 0} Weekly Slots
            </Button>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">{entries.length} events (weekly recurrence)</Text>
            {missingPlate && (
              <Alert color="yellow" title="No background plate">
                A selected template has no background image yet. Open a week's thumbnail editor and
                upload the exported plate under Design, or the thumbnails come out flat blue.
              </Alert>
            )}
            <ScrollArea h={460}>
              <Stack>
                {entries.map((entry, i) => {
                  const stored = templates.find((t) => t.id === entry.templateId);
                  return (
                    <Card key={i} withBorder padding="sm">
                      <Group align="flex-start" wrap="nowrap">
                        <Stack gap="xs" style={{ flex: 1 }}>
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
                          <Select
                            label="Thumbnail template"
                            size="xs"
                            data={templateOptions}
                            value={entry.templateId}
                            onChange={(v) => updateEntry(i, 'templateId', v)}
                            placeholder="No thumbnail"
                            clearable
                            disabled={!!entry.thumbnail}
                          />
                          <FileInput
                            label="Upload instead"
                            accept="image/jpeg,image/png"
                            value={entry.thumbnail}
                            onChange={(file) => updateEntry(i, 'thumbnail', file)}
                            clearable
                            size="xs"
                          />
                        </Stack>

                        <Stack gap="xs" style={{ width: 260 }}>
                          {entry.thumbnail ? (
                            <>
                              <FilePreview file={entry.thumbnail} width={260} />
                              <Badge size="xs" variant="light">Custom image</Badge>
                              <Button size="xs" variant="subtle" onClick={() => updateEntry(i, 'thumbnail', null)}>
                                Back to template
                              </Button>
                            </>
                          ) : stored && thumbnailsReady ? (
                            <>
                              <ThumbnailPreview
                                template={stored.config}
                                vars={{ title: entry.name, date: entry.scheduled_start }}
                                width={260}
                              />
                              <Button size="xs" variant="light" onClick={() => setEditingIndex(i)}>
                                Edit thumbnail
                              </Button>
                            </>
                          ) : (
                            <Text size="xs" c="dimmed">No thumbnail for this week.</Text>
                          )}
                        </Stack>
                      </Group>
                    </Card>
                  );
                })}
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

      {editing && (
        <ThumbnailStudio
          opened
          onClose={() => setEditingIndex(null)}
          title={editing.name}
          date={editing.scheduled_start}
          templateId={editing.templateId}
          useLabel="Use for this week"
          onUse={(file) => {
            // Stored as a manual upload: a hand-edited week should survive later edits to the
            // template it started from.
            if (editingIndex !== null) updateEntry(editingIndex, 'thumbnail', file);
            setEditingIndex(null);
          }}
        />
      )}
    </Modal>
  );
}
