import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Title,
  Stack,
  SimpleGrid,
  Text,
  Card,
  Select,
  Button,
  Badge,
  Group,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useAuth } from '../hooks/useAuth';
import { PlatformCard } from '../components/PlatformCard';
import { ReminderSettingsCard } from '../components/ReminderSettingsCard';
import { api } from '../lib/api';

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
}

export function Settings() {
  const { auth, refresh: refreshAuth } = useAuth();
  const [searchParams] = useSearchParams();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [ffmpegVersion, setFfmpegVersion] = useState<string | null>(null);

  // Facebook page picker state
  const [fbPages, setFbPages] = useState<FacebookPage[]>([]);
  const [showPagePicker, setShowPagePicker] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [savingPage, setSavingPage] = useState(false);
  const [savedPage, setSavedPage] = useState<{ id: string; name: string } | null>(null);
  const [ytChannel, setYtChannel] = useState<{ id: string; title: string } | null>(null);
  const [twitchChannel, setTwitchChannel] = useState<{ id: string; login: string; displayName: string } | null>(null);

  useEffect(() => {
    api.getFfmpegVersion()
      .then((info) => setFfmpegVersion(info.version))
      .catch(() => {});
  }, []);

  // Load the connected account/channel for each platform to show in Settings.
  useEffect(() => {
    if (auth.facebook) {
      api.getFacebookSelectedPage().then(setSavedPage).catch(() => {});
    }
  }, [auth.facebook]);

  useEffect(() => {
    if (auth.youtube) api.getYouTubeChannel().then(setYtChannel).catch(() => {});
  }, [auth.youtube]);

  useEffect(() => {
    if (auth.twitch) api.getTwitchChannel().then(setTwitchChannel).catch(() => {});
  }, [auth.twitch]);

  // Auto-show page picker if redirected from Facebook OAuth
  useEffect(() => {
    if (searchParams.get('pick_page') === 'true') {
      loadFacebookPages();
    }
    // Show notification for successful/failed connections
    const connected = searchParams.get('connected');
    if (connected) {
      notifications.show({ title: 'Connected', message: `${connected} connected successfully`, color: 'green' });
      refreshAuth();
    }
    const error = searchParams.get('error');
    if (error) {
      notifications.show({ title: 'Error', message: `Failed to connect ${error}`, color: 'red' });
    }
  }, [searchParams, refreshAuth]);

  async function loadFacebookPages() {
    try {
      const pages = await api.getFacebookPages();
      setFbPages(pages);
      setShowPagePicker(true);
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    }
  }

  async function saveFacebookPage() {
    const page = fbPages.find((p) => p.id === selectedPageId);
    if (!page) return;

    setSavingPage(true);
    try {
      await api.selectFacebookPage(page.id, page.name, page.access_token);
      notifications.show({ title: 'Success', message: `Selected page: ${page.name}`, color: 'green' });
      setShowPagePicker(false);
      setSavedPage({ id: page.id, name: page.name });
      refreshAuth();
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setSavingPage(false);
    }
  }

  async function handleDisconnect(platform: string) {
    setDisconnecting(platform);
    try {
      await api.disconnectPlatform(platform);
      notifications.show({ title: 'Disconnected', message: `${platform} disconnected`, color: 'blue' });
      refreshAuth();
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <Stack>
      <Title order={2}>Settings</Title>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        <PlatformCard
          name="YouTube"
          connected={auth.youtube}
          connectUrl="/auth/youtube/start"
          onDisconnect={() => handleDisconnect('youtube')}
          disconnecting={disconnecting === 'youtube'}
        >
          {auth.youtube && ytChannel && (
            <Text size="sm">Channel: <Text span fw={600}>{ytChannel.title}</Text></Text>
          )}
        </PlatformCard>

        <PlatformCard
          name="Facebook"
          connected={auth.facebook}
          connectUrl="/auth/facebook/start"
          onDisconnect={() => handleDisconnect('facebook')}
          disconnecting={disconnecting === 'facebook'}
        >
          {showPagePicker && (
            <Card withBorder padding="sm">
              <Stack gap="xs">
                <Text size="sm" fw={500}>Select a Page to stream to:</Text>
                <Select
                  data={fbPages.map((p) => ({ value: p.id, label: p.name }))}
                  value={selectedPageId}
                  onChange={setSelectedPageId}
                  placeholder="Choose a page..."
                />
                <Button
                  size="xs"
                  onClick={saveFacebookPage}
                  loading={savingPage}
                  disabled={!selectedPageId}
                >
                  Save Page Selection
                </Button>
              </Stack>
            </Card>
          )}
          {auth.facebook && !showPagePicker && (
            <Stack gap={6}>
              <Text size="sm">
                Streaming to:{' '}
                <Text span fw={600}>{savedPage ? savedPage.name : 'No page selected yet'}</Text>
              </Text>
              <Button size="xs" variant="light" onClick={loadFacebookPages}>
                {savedPage ? 'Change Page' : 'Select Page'}
              </Button>
            </Stack>
          )}
        </PlatformCard>

        <PlatformCard
          name="Twitch"
          connected={auth.twitch}
          connectUrl="/auth/twitch/start"
          onDisconnect={() => handleDisconnect('twitch')}
          disconnecting={disconnecting === 'twitch'}
        >
          {auth.twitch && twitchChannel && (
            <Text size="sm">Channel: <Text span fw={600}>{twitchChannel.displayName}</Text></Text>
          )}
        </PlatformCard>
      </SimpleGrid>

      {auth.facebook && <ReminderSettingsCard />}

      <Card withBorder>
        <Group justify="space-between">
          <Text fw={500}>FFmpeg</Text>
          <Badge color={ffmpegVersion ? 'green' : 'red'} variant="light">
            {ffmpegVersion ?? 'Not available'}
          </Badge>
        </Group>
      </Card>
    </Stack>
  );
}
