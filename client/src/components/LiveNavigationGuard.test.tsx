import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom';
import { StudioLiveContext, isIntentionalExit } from '../lib/studioLive';
import { api } from '../lib/api';
import { LiveNavigationGuard } from './LiveNavigationGuard';

// The guard's collaborators: end-stream API and toast notifications.
vi.mock('../lib/api', () => ({ api: { endStream: vi.fn() } }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

const endStream = vi.mocked(api.endStream);

// Render the guard inside a real in-memory data router (so useBlocker actually intercepts) with
// a link to navigate, and a forced liveStreamId via context — bypassing the un-mockable studio.
function setup({ liveStreamId, logoutOpen = false }: { liveStreamId: string | null; logoutOpen?: boolean }) {
  const onLogoutOpenChange = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            <Link to="/other">go-other</Link>
            <LiveNavigationGuard logoutOpen={logoutOpen} onLogoutOpenChange={onLogoutOpenChange} />
          </>
        ),
      },
      { path: '/other', element: <div>OTHER PAGE</div> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <MantineProvider>
      <StudioLiveContext.Provider value={{ liveStreamId, setLiveStreamId: vi.fn() }}>
        <RouterProvider router={router} />
      </StudioLiveContext.Provider>
    </MantineProvider>,
  );
  return { onLogoutOpenChange };
}

beforeEach(() => {
  endStream.mockReset();
  sessionStorage.clear();
});

describe('LiveNavigationGuard', () => {
  it('does not block in-app navigation when nothing is live', async () => {
    setup({ liveStreamId: null });
    fireEvent.click(screen.getByText('go-other'));
    expect(await screen.findByText('OTHER PAGE')).toBeTruthy();
    expect(screen.queryByText('Leave this page?')).toBeNull();
  });

  it('blocks in-app navigation while live and shows the guard modal', async () => {
    setup({ liveStreamId: 's1' });
    fireEvent.click(screen.getByText('go-other'));
    expect(await screen.findByText('Leave this page?')).toBeTruthy();
    expect(screen.queryByText('OTHER PAGE')).toBeNull(); // navigation held
  });

  it('"Stay on page" cancels the navigation and does not end the stream', async () => {
    setup({ liveStreamId: 's1' });
    fireEvent.click(screen.getByText('go-other'));
    await screen.findByText('Leave this page?');
    fireEvent.click(screen.getByRole('button', { name: 'Stay on page' }));
    await waitFor(() => expect(screen.queryByText('Leave this page?')).toBeNull());
    expect(screen.queryByText('OTHER PAGE')).toBeNull();
    expect(endStream).not.toHaveBeenCalled();
  });

  it('"End stream & leave" ends the broadcast, then navigates', async () => {
    endStream.mockResolvedValueOnce(undefined);
    setup({ liveStreamId: 's1' });
    fireEvent.click(screen.getByText('go-other'));
    await screen.findByText('Leave this page?');
    fireEvent.click(screen.getByRole('button', { name: 'End stream & leave' }));
    expect(await screen.findByText('OTHER PAGE')).toBeTruthy();
    expect(endStream).toHaveBeenCalledWith('s1');
  });

  it('stays put and does not navigate if ending the stream fails', async () => {
    endStream.mockRejectedValueOnce(new Error('platform error'));
    setup({ liveStreamId: 's1' });
    fireEvent.click(screen.getByText('go-other'));
    await screen.findByText('Leave this page?');
    fireEvent.click(screen.getByRole('button', { name: 'End stream & leave' }));
    await waitFor(() => expect(endStream).toHaveBeenCalledWith('s1'));
    expect(screen.queryByText('OTHER PAGE')).toBeNull(); // failed end -> stayed
  });

  it('logout while live ends the stream, clears the token, and marks intentional exit', async () => {
    endStream.mockResolvedValueOnce(undefined);
    sessionStorage.setItem('auth_token', 'tok');
    vi.stubGlobal('location', { href: '' }); // jsdom can't navigate; capture the redirect

    setup({ liveStreamId: 's1', logoutOpen: true });
    fireEvent.click(screen.getByRole('button', { name: 'End stream & log out' }));

    await waitFor(() => expect(isIntentionalExit()).toBe(true));
    expect(endStream).toHaveBeenCalledWith('s1');
    expect(sessionStorage.getItem('auth_token')).toBeNull();
    expect(window.location.href).toBe('/login');

    vi.unstubAllGlobals();
  });

  it('shows the plain logout copy (no end-stream) when not live', () => {
    setup({ liveStreamId: null, logoutOpen: true });
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End stream & log out' })).toBeNull();
  });
});
