import { useState } from 'react';
import { Center, Card, Stack, Title, TextInput, Button, Text } from '@mantine/core';
import { api } from '../lib/api';

export function Login() {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { token } = await api.login(secret);
      sessionStorage.setItem('auth_token', token);
      // Full navigation (not client-side) so AuthGate + header re-evaluate with the new token.
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center h="100vh">
      <Card withBorder w={400} padding="xl">
        <form onSubmit={handleSubmit}>
          <Stack>
            <Title order={3} ta="center">Local Multistream</Title>
            <Text size="sm" c="dimmed" ta="center">Enter the app password to continue</Text>
            <TextInput
              type="password"
              placeholder="Password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              error={error}
              autoFocus
            />
            <Button type="submit" loading={loading} disabled={!secret}>
              Sign In
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
