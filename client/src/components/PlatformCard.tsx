import { Card, Text, Badge, Group, Stack, Button } from '@mantine/core';

interface PlatformCardProps {
  name: string;
  connected: boolean;
  onConnect: () => void;
  connecting?: boolean;
  onDisconnect: () => void;
  disconnecting?: boolean;
  children?: React.ReactNode;
}

export function PlatformCard({ name, connected, onConnect, connecting, onDisconnect, disconnecting, children }: PlatformCardProps) {
  return (
    <Card shadow="sm" padding="lg" radius="md" withBorder>
      <Stack>
        <Group justify="space-between">
          <Text fw={500} size="lg">{name}</Text>
          <Badge color={connected ? 'green' : 'gray'}>
            {connected ? 'Connected' : 'Not Connected'}
          </Badge>
        </Group>

        {!connected ? (
          <Button onClick={onConnect} loading={connecting} fullWidth>
            Connect {name}
          </Button>
        ) : (
          <>
            <Text size="sm" c="dimmed">Account connected and ready to stream.</Text>
            {children}
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={onDisconnect}
              loading={disconnecting}
            >
              Disconnect {name}
            </Button>
          </>
        )}
      </Stack>
    </Card>
  );
}
