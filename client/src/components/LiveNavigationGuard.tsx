import { useBlocker, type BlockerFunction } from 'react-router-dom';
import { useCallback, useState } from 'react';
import { Modal, Stack, Text, Group, Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';
import { useStudioLive, markIntentionalExit } from '../lib/studioLive';
import { clearAuthToken } from '../lib/authToken';

interface LiveNavigationGuardProps {
  // The "Log out" button lives in the app navbar, so its open state is lifted to App.
  logoutOpen: boolean;
  onLogoutOpenChange: (open: boolean) => void;
}

/**
 * Guards against leaving the page while THIS tab is the live Web Studio source (which would
 * unmount the capture and interrupt the broadcast). Covers in-app navigation via useBlocker
 * (nav links, back/forward, programmatic) and the logout flow. In both cases, confirming ends
 * the broadcast cleanly via api.endStream before leaving rather than orphaning a "live" record.
 * Reads the live stream id from StudioLiveContext (set by StreamPage).
 */
export function LiveNavigationGuard({ logoutOpen, onLogoutOpenChange }: LiveNavigationGuardProps) {
  const { liveStreamId } = useStudioLive();
  const studioLive = liveStreamId !== null;
  const [leaving, setLeaving] = useState(false);

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
    clearAuthToken();
    // Full navigation (not client-side) so AuthGate + header re-evaluate without the token.
    window.location.href = '/login';
  }

  return (
    <>
      {/* Logout confirmation. While live, logging out ends the broadcast first (confirmLogout). */}
      <Modal
        opened={logoutOpen}
        onClose={() => { if (!leaving) onLogoutOpenChange(false); }}
        title="Log out"
        centered
      >
        <Stack>
          {studioLive && (
            <Text c="red" fw={600}>
              ⚠️ You're LIVE via the Web Studio in this tab. Logging out will end the broadcast
              first — all platforms stop and recordings are finalized. This cannot be undone.
            </Text>
          )}
          <Text>You'll need the app password to sign back in.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => onLogoutOpenChange(false)} disabled={leaving}>Cancel</Button>
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
            this stops all platform streams and finalizes recordings. This cannot be undone.
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
    </>
  );
}
