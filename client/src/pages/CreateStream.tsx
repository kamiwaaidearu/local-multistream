import { useNavigate, useParams } from 'react-router-dom';
import { Title, Stack } from '@mantine/core';
import { api } from '../lib/api';
import { StreamForm } from '../components/StreamForm';

export function CreateStream() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  async function handleSave(formData: FormData) {
    if (isEdit && id) {
      await api.updateStream(id, formData);
      navigate(`/streams/${id}`);
    } else {
      const stream = await api.createStream(formData);
      navigate(`/streams/${(stream as { id: string }).id}`);
    }
  }

  return (
    <Stack maw={600}>
      <Title order={2}>{isEdit ? 'Edit Stream' : 'New Stream'}</Title>
      <StreamForm
        onSave={handleSave}
        onCancel={() => navigate(-1)}
        saveLabel={isEdit ? 'Save Changes' : 'Create Stream'}
      />
    </Stack>
  );
}
