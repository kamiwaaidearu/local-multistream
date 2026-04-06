import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { AppShell, Group, Title, NavLink as MantineNavLink } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { CreateStream } from './pages/CreateStream';
import { StreamDetail } from './pages/StreamDetail';
import { Settings } from './pages/Settings';
import { api } from './lib/api';

export function App() {
  const [auth, setAuth] = useState({ youtube: false, facebook: false, twitch: false });

  useEffect(() => {
    api.getAuthStatus().then(setAuth).catch(() => {});
  }, []);

  return (
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
          <Route path="/streams/:id" element={<StreamDetail />} />
          <Route path="/streams/:id/edit" element={<CreateStream />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
