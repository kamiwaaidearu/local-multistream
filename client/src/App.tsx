import { Routes, Route, NavLink, Navigate, useLocation, useBlocker, type BlockerFunction } from 'react-router-dom';
import { AppShell, Group, Title, NavLink as MantineNavLink, Stack, Button, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { CreateStream } from './pages/CreateStream';
import { StreamPage } from './pages/StreamPage';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { api } from './lib/api';
import { StudioLiveContext, markIntentionalExit } from './lib/studioLive';

function AuthGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [checking, setChecking] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    api.checkAuth()
      .then(({ required }) => {
        if (required && !sessionStorage.getItem('auth_token')) {
          setNeedsAuth(true);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  if (needsAuth && location.pathname !== '/login') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export function App() {
  const [auth, setAuth] = useState({ youtube: false, facebook: false, twitch: false });
  const [liveStreamId, setLiveStreamId] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    api.getAuthStatus().then(setAuth).catch(() => {});
  }, []);

  // Stable context value so StreamPage (the only consumer) doesn't re-render on every App render.
  const studioLiveValue = useMemo(() => ({ liveStreamId, setLiveStreamId }), [liveStreamId]);

  // True while this tab is the live Web Studio source — leaving the page would interrupt it.
  const studioLive = liveStreamId !== null;

  // Only show "Log out" when a session token exists (auth enabled + logged in). In no-auth
  // mode there's no token, so the button stays hidden.
  const authToken = sessionStorage.getItem('auth_token');

  // Guard all in-app navigation (nav links, back/forward, programmatic navigate) while this tab is
  // the live Web Studio source. Full-page exits (refresh/close) are caught by StreamPage's
  // beforeunload; an intentional logout suppresses that (see confirmLogout / markIntentionalExit).
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        studioLive && currentLocation.pathname !== nextLocation.pathname,
      [studioLive],
    ),
  );

  // End the in-progress broadcast cleanly (stop fan-out, end platform broadcasts, capture VODs)
  // before navigating away. Returns false if it failed, so the caller can stay put rather than
  // leave a half-ended stream. No-op (returns true) when nothing is live in this tab.
  const endActiveStream = useCallback(async (): Promise<boolean> => {
    if (!liveStreamId) return true;
    setLeaving(true);
    try {
      await api.endStream(liveStreamId);
      return true;
    } catch (err) {
      notifications.show({ title: 'Could not end the stream', message: String(err), color: 'red' });
      return false;
    } finally {
      setLeaving(false);
    }
  }, [liveStreamId]);

  async function confirmLogout() {
    // If we're the live source, end the broadcast cleanly first — otherwise logging out just
    // kills the source and leaves a dangling "live" stream. Stay put if that end fails.
    if (!(await endActiveStream())) return;
    // The logout modal already confirmed; suppress StreamPage's beforeunload so the browser
    // doesn't prompt a second time on the redirect.
    markIntentionalExit();
    sessionStorage.removeItem('auth_token');
    // Full navigation (not client-side) so AuthGate + header re-evaluate without the token.
    window.location.href = '/login';
  }

  return (
    <StudioLiveContext.Provider value={studioLiveValue}>
      <AuthGate>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="*"
            element={
              <AppShell
                header={{ height: 60 }}
                navbar={{ width: 220, breakpoint: 'sm' }}
                padding="md"
              >
                <AppShell.Header>
                  <Group h="100%" px="md" justify="space-between">
                    <Title order={3}>Local Multistream</Title>
                    <Group gap="xs">
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: auth.youtube ? '#40c057' : '#868e96' }} title="YouTube" />
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: auth.facebook ? '#40c057' : '#868e96' }} title="Facebook" />
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: auth.twitch ? '#40c057' : '#868e96' }} title="Twitch" />
                    </Group>
                  </Group>
                </AppShell.Header>

                <AppShell.Navbar p="sm">
                  <Stack h="100%" justify="space-between" gap="sm">
                    <Stack gap={0}>
                      <MantineNavLink label="Dashboard" component={NavLink} to="/" />
                      <MantineNavLink label="New Stream" component={NavLink} to="/streams/new" />
                      <MantineNavLink label="Settings" component={NavLink} to="/settings" />
                    </Stack>
                    {authToken && (
                      <Button variant="light" color="gray" onClick={() => setLogoutOpen(true)} fullWidth>
                        Log out
                      </Button>
                    )}
                  </Stack>
                </AppShell.Navbar>

                <AppShell.Main>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/streams/new" element={<CreateStream />} />
                    <Route path="/streams/:id" element={<StreamPage />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AppShell.Main>
              </AppShell>
            }
          />
        </Routes>
      </AuthGate>

      {/* Logout confirmation. While live, logging out ends the broadcast first (confirmLogout). */}
      <Modal
        opened={logoutOpen}
        onClose={() => { if (!leaving) setLogoutOpen(false); }}
        title="Log out"
        centered
      >
        <Stack>
          {studioLive && (
            <Text c="red" fw={600}>
              ⚠️ You're LIVE via the Web Studio in this tab. Logging out will end the broadcast
              first — all platforms stop and recordings are finalized.
            </Text>
          )}
          <Text>You'll need the app password to sign back in.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setLogoutOpen(false)} disabled={leaving}>Cancel</Button>
            <Button color={studioLive ? 'red' : undefined} loading={leaving} onClick={confirmLogout}>
              {studioLive ? 'End stream & log out' : 'Log out'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Global navigation guard — fires for nav links, the back button, and any programmatic
          navigation while this tab is the live Web Studio source. */}
      <Modal
        opened={blocker.state === 'blocked'}
        onClose={() => { if (!leaving) blocker.reset?.(); }}
        title="Leave this page?"
        centered
      >
        <Stack>
          <Text c="red" fw={600}>
            ⚠️ You're LIVE via the Web Studio in this tab. To leave, the broadcast must end —
            this stops all platform streams and finalizes recordings.
          </Text>
          <Text size="sm" c="dimmed">
            Staying keeps you live. Choose “End stream &amp; leave” only when you're done.
          </Text>
          <Group justify="flex-end">
            <Button onClick={() => blocker.reset?.()} disabled={leaving}>Stay on page</Button>
            <Button
              color="red"
              variant="outline"
              loading={leaving}
              onClick={async () => { if (await endActiveStream()) blocker.proceed?.(); }}
            >
              End stream &amp; leave
            </Button>
          </Group>
        </Stack>
      </Modal>
    </StudioLiveContext.Provider>
  );
}
