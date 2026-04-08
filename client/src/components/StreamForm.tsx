import { useState, useEffect } from 'react';
import {
  TextInput,
  Textarea,
  Button,
  Stack,
  Group,
  FileInput,
  Image,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';

interface StreamFormData {
  name: string;
  description: string | null;
  thumbnail_path: string | null;
  scheduled_start: number | null;
}

interface StreamFormProps {
  initialData?: StreamFormData;
  onSave: (formData: FormData) => Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
}

export function StreamForm({ initialData, onSave, onCancel, saveLabel = 'Save' }: StreamFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [scheduledStart, setScheduledStart] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name || '');
      setDescription(initialData.description || '');
      if (initialData.scheduled_start) {
        setScheduledStart(new Date(initialData.scheduled_start * 1000));
      }
    }
  }, [initialData]);

  const thumbnailPreview = thumbnail ? URL.createObjectURL(thumbnail) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      notifications.show({ title: 'Error', message: 'Name is required', color: 'red' });
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('description', description);
      if (thumbnail) formData.append('thumbnail', thumbnail);
      if (scheduledStart) formData.append('scheduled_start', String(Math.floor(scheduledStart.getTime() / 1000)));
      await onSave(formData);
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack>
        <TextInput
          label="Name"
          placeholder="Tuesday Rosary"
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />

        <Textarea
          label="Description"
          placeholder="Join us for the weekly rosary..."
          minRows={3}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />

        <FileInput
          label="Thumbnail"
          description="JPEG or PNG, max 2MB, recommended 1280x720"
          accept="image/jpeg,image/png"
          value={thumbnail}
          onChange={setThumbnail}
        />

        {thumbnailPreview && (
          <Image src={thumbnailPreview} height={180} radius="md" alt="Thumbnail preview" />
        )}

        <DateTimePicker
          label="Scheduled start"
          description="Optional — leave blank to go live manually"
          value={scheduledStart}
          onChange={setScheduledStart}
          clearable
        />

        <Group>
          <Button type="submit" loading={saving}>
            {saveLabel}
          </Button>
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
