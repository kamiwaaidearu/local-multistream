import { useEffect, useState } from 'react';
import {
  Card, Stack, Group, Switch, TextInput, Textarea, Select, NumberInput,
  Button, ActionIcon, Text, Divider, Code,
} from '@mantine/core';
import { TimeInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { api, type ReminderSettings, type ReminderRule, type ReminderWhen } from '../lib/api';

const WEEKDAYS = [
  { value: '0', label: 'Sunday' }, { value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' }, { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

function defaultWhen(kind: ReminderWhen['kind']): ReminderWhen {
  if (kind === 'sameDayAt') return { kind: 'sameDayAt', time: '08:00' };
  if (kind === 'weekdayBeforeAt') return { kind: 'weekdayBeforeAt', weekday: 0, time: '18:00' };
  return { kind: 'beforeStart', minutes: 60 };
}

function newRule(): ReminderRule {
  return {
    id: crypto.randomUUID(),
    label: 'New reminder',
    enabled: true,
    when: { kind: 'beforeStart', minutes: 60 },
    template: '{title} — live {datetime}\n\n{description}\n\n▶️ {site}',
  };
}

export function ReminderSettingsCard() {
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getReminderSettings().then(setSettings).catch(() => {});
  }, []);

  if (!settings) return null;

  const update = (patch: Partial<ReminderSettings>) => setSettings({ ...settings, ...patch });
  const updateRule = (i: number, patch: Partial<ReminderRule>) => {
    const rules = settings.rules.map((r, j) => (j === i ? { ...r, ...patch } : r));
    update({ rules });
  };
  const setWhen = (i: number, when: ReminderWhen) => updateRule(i, { when });

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await api.updateReminderSettings(settings);
      notifications.show({ title: 'Saved', message: 'Reminder schedule saved', color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>Facebook reminders</Text>
            <Text size="xs" c="dimmed">
              Auto-scheduled announcement posts for upcoming streams. (Facebook's API can't schedule
              the live video or create events, so these posts provide the advance heads-up.)
            </Text>
          </div>
          <Switch
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.currentTarget.checked })}
            label={settings.enabled ? 'On' : 'Off'}
          />
        </Group>

        <Group grow>
          <TextInput
            label="Time zone"
            description="IANA name, e.g. America/New_York"
            value={settings.timezone}
            onChange={(e) => update({ timezone: e.currentTarget.value })}
          />
          <TextInput
            label="Site link"
            description="Fills the {site} placeholder"
            value={settings.site}
            onChange={(e) => update({ site: e.currentTarget.value })}
          />
        </Group>

        <Divider label="Reminders" labelPosition="left" />

        {settings.rules.map((rule, i) => (
          <Card withBorder key={rule.id} padding="sm" bg="var(--mantine-color-default-hover)">
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <TextInput
                  style={{ flex: 1 }}
                  placeholder="Label"
                  value={rule.label}
                  onChange={(e) => updateRule(i, { label: e.currentTarget.value })}
                />
                <Switch
                  checked={rule.enabled}
                  onChange={(e) => updateRule(i, { enabled: e.currentTarget.checked })}
                />
                <ActionIcon
                  color="red"
                  variant="subtle"
                  aria-label="Remove reminder"
                  onClick={() => update({ rules: settings.rules.filter((_, j) => j !== i) })}
                >
                  ✕
                </ActionIcon>
              </Group>

              <Group grow align="flex-end">
                <Select
                  label="When"
                  data={[
                    { value: 'sameDayAt', label: 'Morning of (same day)' },
                    { value: 'weekdayBeforeAt', label: 'A weekday before' },
                    { value: 'beforeStart', label: 'Time before start' },
                  ]}
                  value={rule.when.kind}
                  onChange={(v) => v && setWhen(i, defaultWhen(v as ReminderWhen['kind']))}
                />

                {rule.when.kind === 'sameDayAt' && (
                  <TimeInput
                    label="At"
                    value={rule.when.time}
                    onChange={(e) => setWhen(i, { kind: 'sameDayAt', time: e.currentTarget.value })}
                  />
                )}

                {rule.when.kind === 'weekdayBeforeAt' && (
                  <>
                    <Select
                      label="Weekday"
                      data={WEEKDAYS}
                      value={String(rule.when.weekday)}
                      onChange={(v) =>
                        rule.when.kind === 'weekdayBeforeAt' &&
                        setWhen(i, { kind: 'weekdayBeforeAt', weekday: Number(v), time: rule.when.time })
                      }
                    />
                    <TimeInput
                      label="At"
                      value={rule.when.time}
                      onChange={(e) =>
                        rule.when.kind === 'weekdayBeforeAt' &&
                        setWhen(i, { kind: 'weekdayBeforeAt', weekday: rule.when.weekday, time: e.currentTarget.value })
                      }
                    />
                  </>
                )}

                {rule.when.kind === 'beforeStart' && (
                  <NumberInput
                    label="Minutes before"
                    min={1}
                    value={rule.when.minutes}
                    onChange={(v) => setWhen(i, { kind: 'beforeStart', minutes: Number(v) || 0 })}
                  />
                )}
              </Group>

              <Textarea
                label="Post text"
                autosize
                minRows={2}
                value={rule.template}
                onChange={(e) => updateRule(i, { template: e.currentTarget.value })}
              />
            </Stack>
          </Card>
        ))}

        <Button variant="light" onClick={() => update({ rules: [...settings.rules, newRule()] })}>
          + Add reminder
        </Button>

        <Divider label="When you go live" labelPosition="left" />

        <Card withBorder padding="sm" bg="var(--mantine-color-default-hover)">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={500}>“We’re live now” post</Text>
              <Switch
                checked={settings.goLivePost.enabled}
                onChange={(e) => update({ goLivePost: { ...settings.goLivePost, enabled: e.currentTarget.checked } })}
              />
            </Group>
            <Text size="xs" c="dimmed">
              Posted the moment you go live — the only post that can link to the actual broadcast
              via <Code>{'{video}'}</Code>.
            </Text>
            <Textarea
              autosize
              minRows={2}
              value={settings.goLivePost.template}
              onChange={(e) => update({ goLivePost: { ...settings.goLivePost, template: e.currentTarget.value } })}
            />
          </Stack>
        </Card>

        <Group justify="flex-end">
          <Button onClick={save} loading={saving}>Save reminders</Button>
        </Group>

        <Text size="xs" c="dimmed">
          Placeholders: <Code>{'{title}'}</Code> <Code>{'{description}'}</Code> <Code>{'{date}'}</Code>{' '}
          <Code>{'{time}'}</Code> <Code>{'{datetime}'}</Code> <Code>{'{weekday}'}</Code>{' '}
          <Code>{'{page}'}</Code> (Page — advance posts) <Code>{'{video}'}</Code> (broadcast — go-live post only){' '}
          <Code>{'{site}'}</Code> (external site)
        </Text>
      </Stack>
    </Card>
  );
}
