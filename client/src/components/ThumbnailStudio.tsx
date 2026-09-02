import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Button,
  Card,
  ColorInput,
  Divider,
  FileButton,
  Grid,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import { api, type StoredThumbnailTemplate } from '../lib/api';
import { useThumbnailTemplates } from '../hooks/useThumbnailTemplates';
import { ThumbnailPreview } from './ThumbnailPreview';
import {
  loadPlate,
  parseNumericField,
  renderThumbnailFile,
  thumbnailFilename,
  type LaidOutElement,
  type ThumbnailTemplate,
  type ThumbnailTextElement,
} from '../lib/thumbnailTemplate';

interface ThumbnailStudioProps {
  opened: boolean;
  onClose: () => void;
  /** Title used for {{title}}. Editable inside the modal. */
  title?: string;
  /** Date used for {{date}}. Editable inside the modal. */
  date?: Date | null;
  /** Template to open with; falls back to the first one. */
  templateId?: string | null;
  /** Receives the rendered JPEG. Omit for a download-only session. */
  onUse?: (file: File, templateId: string) => void;
  useLabel?: string;
}

/**
 * The thumbnail generator: pick a template, type the copy, see it rendered, and hand the result
 * straight to whichever form asked for it.
 *
 * "Design" edits and copy edits are the same edit — both change the working template — but only
 * "Save design" writes back to the server. That way a one-off wording change for a single week
 * never quietly rewrites the template every other week depends on.
 */
export function ThumbnailStudio({
  opened,
  onClose,
  title = '',
  date = null,
  templateId = null,
  onUse,
  useLabel = 'Use this thumbnail',
}: ThumbnailStudioProps) {
  const { templates, plates, ready, error, fontWarning, reload } = useThumbnailTemplates(opened);

  const [selectedId, setSelectedId] = useState<string | null>(templateId);
  const [working, setWorking] = useState<ThumbnailTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [varTitle, setVarTitle] = useState(title);
  const [varDate, setVarDate] = useState<Date | null>(date);
  const [laidOut, setLaidOut] = useState<LaidOutElement[]>([]);
  const [busy, setBusy] = useState(false);

  // Re-seed the variables whenever the modal is opened from a different stream.
  useEffect(() => {
    if (opened) {
      setVarTitle(title);
      setVarDate(date);
    }
  }, [opened, title, date]);

  const selected: StoredThumbnailTemplate | undefined = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? templates[0],
    [templates, selectedId],
  );

  // Load the chosen template into the working copy. Keyed on id so retyping copy does not clobber
  // itself, but switching templates starts fresh from what the server has.
  useEffect(() => {
    if (!selected) return;
    setWorking(structuredClone(selected.config));
    setSelectedId(selected.id);
    setDirty(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const vars = useMemo(() => ({ title: varTitle, date: varDate }), [varTitle, varDate]);

  function patchTemplate(patch: Partial<ThumbnailTemplate>) {
    setWorking((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  /** Writes a numeric Design field, holding the last good value while the input is mid-edit or
   *  empty. See parseNumericField for why a direct Number() coercion corrupted templates. */
  function patchNumber(
    id: string,
    key: 'x' | 'y' | 'maxWidth' | 'maxLines' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing',
    value: string | number,
    min: number,
    max: number,
  ) {
    const n = parseNumericField(value, min, max);
    if (n === null) return;
    patchElement(id, { [key]: n });
  }

  function patchElement(id: string, patch: Partial<ThumbnailTextElement>) {
    setWorking((prev) =>
      prev
        ? { ...prev, elements: prev.elements.map((el) => (el.id === id ? { ...el, ...patch } : el)) }
        : prev,
    );
    setDirty(true);
  }

  async function buildFile(): Promise<File | null> {
    if (!working) return null;
    const plateImage = await loadPlate(working.plate);
    if (working.plate && !plateImage) {
      notifications.show({
        title: 'Background plate missing',
        message: 'The template points at a plate image that could not be loaded. Pick one under Design.',
        color: 'red',
      });
      return null;
    }
    return renderThumbnailFile(working, vars, plateImage, thumbnailFilename(varTitle || working.name));
  }

  async function handleUse() {
    if (!working || !onUse) return;
    setBusy(true);
    try {
      const file = await buildFile();
      if (file) {
        onUse(file, working.id);
        onClose();
      }
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload() {
    setBusy(true);
    try {
      const file = await buildFile();
      if (!file) return;
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDesign() {
    if (!working) return;
    setBusy(true);
    try {
      await api.updateThumbnailTemplate(working.id, { name: working.name, config: working });
      await reload();
      setDirty(false);
      notifications.show({ title: 'Saved', message: `Template "${working.name}" updated`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  async function handleDuplicate() {
    if (!working) return;
    setBusy(true);
    try {
      const created = await api.createThumbnailTemplate({
        name: `${working.name} copy`,
        config: working,
      });
      await reload();
      setSelectedId(created.id);
      notifications.show({ title: 'Duplicated', message: `Created "${created.name}"`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Restores the stock templates to their seeded Figma geometry, keeping whatever plate is selected.
   *
   * Without this there was no way back from a botched Design edit once it had been saved — the
   * server route existed but nothing in the UI called it.
   */
  async function handleReset() {
    if (!window.confirm(
      'Reset the stock templates (Weekly, Latin special edition) to their original layout?\n\n' +
      'Your uploaded background plate is kept, and templates you created yourself are untouched.',
    )) return;
    setBusy(true);
    try {
      const restored = await api.resetThumbnailTemplates();
      await reload();
      // The load effect is keyed on the selected id, which has not changed, so the working copy has
      // to be refreshed explicitly or the editor would keep showing the pre-reset design.
      const mine = restored.find((t) => t.id === working?.id);
      if (mine) {
        setWorking(structuredClone(mine.config));
        setDirty(false);
      }
      notifications.show({ title: 'Reset', message: 'Stock templates restored', color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadPlate(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const plate = await api.uploadThumbnailPlate(formData);
      await reload();
      patchTemplate({ plate: plate.url });
      notifications.show({
        title: 'Plate uploaded',
        message: 'Save the design to keep this background on the template.',
        color: 'green',
      });
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setBusy(false);
    }
  }

  const shrunk = laidOut.filter((l) => l.shrunk);

  return (
    <Modal opened={opened} onClose={onClose} title="Thumbnail generator" size="xl">
      {error && <Alert color="red">{error}</Alert>}
      {!ready || !working ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : (
        <Stack>
          <Select
            label="Template"
            data={templates.map((t) => ({ value: t.id, label: t.name }))}
            value={working.id}
            onChange={setSelectedId}
            allowDeselect={false}
          />

          <ThumbnailPreview template={working} vars={vars} width={640} onLaidOut={setLaidOut} />

          {!working.plate && (
            <Alert color="yellow" title="No background plate">
              This template has no background image yet. Open Design below and upload the exported
              plate — the flat blue behind the text is only a fallback.
            </Alert>
          )}
          {fontWarning && (
            <Alert color="yellow" title="Brand font unavailable">
              {fontWarning}
            </Alert>
          )}
          {shrunk.length > 0 && (
            <Alert color="yellow" title="Text was shrunk to fit">
              {shrunk.map((l) => l.element.label).join(', ')} — shorten the copy, or widen the
              element under Design, if the size looks off.
            </Alert>
          )}

          <Grid>
            <Grid.Col span={{ base: 12, sm: 7 }}>
              <TextInput
                label="Title"
                description="Fills {{title}}"
                value={varTitle}
                onChange={(e) => setVarTitle(e.currentTarget.value)}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 5 }}>
              <DateTimePicker label="Date" description="Fills {{date}}" value={varDate} onChange={setVarDate} />
            </Grid.Col>
          </Grid>

          <Divider label="Text" />
          {working.elements
            .filter((el) => el.editable)
            .map((el) => (
              <Textarea
                key={el.id}
                label={el.label}
                description="Literal text. {{title}} and {{date}} are substituted; {{date:short}} and {{date:weekday}} also work."
                autosize
                minRows={1}
                value={el.text}
                onChange={(e) => patchElement(el.id, { text: e.currentTarget.value })}
              />
            ))}

          <Accordion variant="contained">
            <Accordion.Item value="design">
              <Accordion.Control>Design — plate, position, typography</Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  <TextInput
                    label="Template name"
                    value={working.name}
                    onChange={(e) => patchTemplate({ name: e.currentTarget.value })}
                  />
                  <Group align="end">
                    <Select
                      label="Background plate"
                      style={{ flex: 1 }}
                      data={plates.map((p) => ({ value: p.url, label: p.name }))}
                      value={working.plate}
                      onChange={(v) => patchTemplate({ plate: v })}
                      placeholder="None — flat colour"
                      clearable
                    />
                    <FileButton onChange={handleUploadPlate} accept="image/png,image/jpeg,image/webp">
                      {(props) => <Button {...props} variant="light">Upload plate</Button>}
                    </FileButton>
                  </Group>
                  <ColorInput
                    label="Fallback background colour"
                    value={working.backgroundColor}
                    onChange={(v) => patchTemplate({ backgroundColor: v })}
                  />

                  {working.elements.map((el) => (
                    <Card key={el.id} withBorder padding="sm">
                      <Stack gap="xs">
                        <Group justify="space-between">
                          <TextInput
                            size="xs"
                            label="Element label"
                            value={el.label}
                            onChange={(e) => patchElement(el.id, { label: e.currentTarget.value })}
                          />
                          <Switch
                            size="xs"
                            label="Show in fill-in form"
                            checked={el.editable}
                            onChange={(e) => patchElement(el.id, { editable: e.currentTarget.checked })}
                          />
                        </Group>
                        <Group grow>
                          <NumberInput
                            size="xs" label="X" min={0} max={1} step={0.005} decimalScale={3}
                            value={el.x} onChange={(v) => patchNumber(el.id, 'x', v, 0, 1)}
                          />
                          <NumberInput
                            size="xs" label="Y" min={0} max={1} step={0.005} decimalScale={3}
                            value={el.y} onChange={(v) => patchNumber(el.id, 'y', v, 0, 1)}
                          />
                          <NumberInput
                            size="xs" label="Max width" min={0.05} max={1} step={0.01} decimalScale={3}
                            value={el.maxWidth} onChange={(v) => patchNumber(el.id, 'maxWidth', v, 0.05, 1)}
                          />
                        </Group>
                        <Group grow>
                          <NumberInput
                            size="xs" label="Font size" min={0.01} max={0.4} step={0.002} decimalScale={4}
                            value={el.fontSize} onChange={(v) => patchNumber(el.id, 'fontSize', v, 0.01, 0.4)}
                          />
                          <NumberInput
                            size="xs" label="Weight" min={200} max={900} step={100}
                            value={el.fontWeight} onChange={(v) => patchNumber(el.id, 'fontWeight', v, 200, 900)}
                          />
                          <NumberInput
                            size="xs" label="Line height" min={0.6} max={2} step={0.01} decimalScale={2}
                            value={el.lineHeight} onChange={(v) => patchNumber(el.id, 'lineHeight', v, 0.6, 2)}
                          />
                        </Group>
                        <Group grow>
                          <NumberInput
                            size="xs" label="Max lines" min={1} max={6}
                            value={el.maxLines} onChange={(v) => patchNumber(el.id, 'maxLines', v, 1, 6)}
                          />
                          <NumberInput
                            size="xs" label="Tracking (em)" min={-0.1} max={0.5} step={0.005} decimalScale={3}
                            value={el.letterSpacing} onChange={(v) => patchNumber(el.id, 'letterSpacing', v, -0.1, 0.5)}
                          />
                          <ColorInput
                            size="xs" label="Colour" value={el.color}
                            onChange={(v) => patchElement(el.id, { color: v })}
                          />
                        </Group>
                        <Select
                          size="xs"
                          label="Shrink with"
                          description="Follows that element down when a long title has to shrink, so this one keeps its relative size."
                          data={working.elements
                            .filter((o) => o.id !== el.id)
                            .map((o) => ({ value: o.id, label: o.label }))}
                          value={el.scaleWith ?? null}
                          onChange={(v) => patchElement(el.id, { scaleWith: v })}
                          placeholder="Independent"
                          clearable
                        />
                        <Group grow>
                          <Select
                            size="xs" label="Align" allowDeselect={false}
                            data={['left', 'center', 'right']} value={el.align}
                            onChange={(v) => patchElement(el.id, { align: v as ThumbnailTextElement['align'] })}
                          />
                          <Select
                            size="xs" label="Anchor" allowDeselect={false}
                            data={[
                              { value: 'top', label: 'Top of block' },
                              { value: 'middle', label: 'Middle' },
                              { value: 'bottom', label: 'Bottom of block' },
                            ]}
                            value={el.vAlign}
                            onChange={(v) => patchElement(el.id, { vAlign: v as ThumbnailTextElement['vAlign'] })}
                          />
                        </Group>
                        <Group>
                          <Switch
                            size="xs" label="Italic" checked={el.italic}
                            onChange={(e) => patchElement(el.id, { italic: e.currentTarget.checked })}
                          />
                          <Switch
                            size="xs" label="Uppercase" checked={el.uppercase}
                            onChange={(e) => patchElement(el.id, { uppercase: e.currentTarget.checked })}
                          />
                          <Tooltip label="Remove this text element from the template">
                            <ActionIcon
                              size="sm" color="red" variant="subtle"
                              onClick={() =>
                                patchTemplate({ elements: working.elements.filter((o) => o.id !== el.id) })
                              }
                            >
                              ✕
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Stack>
                    </Card>
                  ))}

                  <Group>
                    <Button
                      variant="light"
                      onClick={() =>
                        patchTemplate({ elements: [...working.elements, newElement(working.elements.length)] })
                      }
                    >
                      Add text element
                    </Button>
                    <Button variant="light" onClick={handleDuplicate} loading={busy}>
                      Duplicate template
                    </Button>
                    <Button
                      variant={dirty ? 'filled' : 'default'}
                      onClick={handleSaveDesign}
                      loading={busy}
                    >
                      Save design
                    </Button>
                    <Button variant="subtle" color="red" onClick={handleReset} loading={busy}>
                      Reset to default
                    </Button>
                  </Group>
                  {dirty && (
                    <Text size="xs" c="dimmed">
                      Unsaved design changes apply to this thumbnail only until you save them.
                    </Text>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          <Group justify="space-between">
            <Button variant="subtle" onClick={handleDownload} loading={busy}>
              Download JPEG
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              {onUse && (
                <Button onClick={handleUse} loading={busy}>
                  {useLabel}
                </Button>
              )}
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function newElement(index: number): ThumbnailTextElement {
  return {
    id: `text-${index + 1}-${Math.random().toString(36).slice(2, 7)}`,
    label: `Text ${index + 1}`,
    text: 'New text',
    editable: true,
    x: 0.5,
    y: 0.5,
    maxWidth: 0.86,
    maxLines: 2,
    align: 'center',
    vAlign: 'bottom',
    fontSize: 0.08,
    fontWeight: 700,
    italic: false,
    uppercase: false,
    color: '#ffffff',
    lineHeight: 1,
    letterSpacing: 0,
    scaleWith: null,
  };
}
