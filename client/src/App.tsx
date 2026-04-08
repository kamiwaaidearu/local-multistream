import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { AppShell, Group, Title, NavLink as MantineNavLink } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { CreateStream } from './pages/CreateStream';
import { StreamPage } from './pages/StreamPage';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { api } from './lib/api';

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

  useEffect(() => {
    api.getAuthStatus().then(setAuth).catch(() => {});
  }, []);

  return (
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
                <MantineNavLink
                  label="Dashboard"
                  component={NavLink}
                  to="/"
                />
                <MantineNavLink
                  label="New Stream"
                  component={NavLink}
                  to="/streams/new"
                />
                <MantineNavLink
                  label="Settings"
                  component={NavLink}
                  to="/settings"
                />
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
  );
}
