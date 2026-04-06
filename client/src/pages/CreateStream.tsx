import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Title,
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
import { api } from '../lib/api';

export function CreateStream() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [scheduledStart, setScheduledStart] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

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

      if (isEdit && id) {
        await api.updateStream(id, formData);
        navigate(`/streams/${id}`);
      } else {
        const stream = await api.createStream(formData);
        navigate(`/streams/${(stream as { id: string }).id}`);
      }
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack maw={600}>
        <Title order={2}>{isEdit ? 'Edit Stream' : 'New Stream'}</Title>

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
            {isEdit ? 'Save Changes' : 'Create Stream'}
          </Button>
          <Button variant="subtle" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
