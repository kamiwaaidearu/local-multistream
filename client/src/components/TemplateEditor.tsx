import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Stack,
  Group,
  Card,
  Button,
  Select,
  TextInput,
  Textarea,
  NumberInput,
  ColorInput,
  SegmentedControl,
  Text,
  Badge,
  ActionIcon,
  Box,
  Collapse,
  Divider,
  FileButton,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { GridTemplate, GridCell, CellContent, GridTrackSize } from '../lib/gridTemplate';
import { resolveTrackSizes, applyAspectRatioConstraints } from '../lib/gridTemplate';
import { api } from '../lib/api';

interface TemplateEditorProps {
  template: GridTemplate;
  savedTemplate: GridTemplate | null;
  onTemplateChange: (template: GridTemplate) => void;
  onSave: () => void;
  onReset: () => void;
}

const CONTENT_TYPE_OPTIONS = [
  { value: 'screenShare', label: 'Screen Share' },
  { value: 'webcam', label: 'Camera' },
  { value: 'image', label: 'Image' },
  { value: 'text', label: 'Text' },
  { value: 'empty', label: 'Empty' },
];

const OBJECT_FIT_OPTIONS = [
  { value: 'contain', label: 'Fit inside (letterbox)' },
  { value: 'cover', label: 'Fill area (crop)' },
  { value: 'fill', label: 'Stretch to fill' },
];

function contentTypeLabel(type: string): string {
  return CONTENT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}

function frPercentLabel(tracks: GridTrackSize[], index: number): string | null {
  const track = tracks[index];
  if (track.unit !== 'fr') return null;
  const totalFr = tracks.reduce((sum, t) => sum + (t.unit === 'fr' ? t.value : 0), 0);
  return totalFr > 0 ? `${Math.round((track.value / totalFr) * 100)}%` : null;
}

function makeDefaultContent(type: string): CellContent {
  switch (type) {
    case 'screenShare':
      return { type: 'screenShare', objectFit: 'contain' };
    case 'webcam':
      return { type: 'webcam', objectFit: 'contain' };
    case 'image':
      return { type: 'image', src: '', objectFit: 'contain' };
    case 'text':
      return {
        type: 'text',
        content: 'Text',
        fontSize: 24,
        fontFamily: 'sans-serif',
        color: '#ffffff',
        align: 'left',
        verticalAlign: 'top',
      };
    default:
      return { type: 'empty' };
  }
}

export function TemplateEditor({
  template,
  savedTemplate,
  onTemplateChange,
  onSave,
  onReset,
}: TemplateEditorProps) {
  const [open, setOpen] = useState(false);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Undo stack
  const undoStack = useRef<GridTemplate[]>([]);
  const pushUndo = useCallback(() => {
    undoStack.current.push(structuredClone(template));
    if (undoStack.current.length > 20) undoStack.current.shift();
  }, [template]);

  const handleUndo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (prev) onTemplateChange(prev);
  }, [onTemplateChange]);

  const isDirty = savedTemplate
    ? JSON.stringify(template) !== JSON.stringify(savedTemplate)
    : false;

  const selectedCell = template.cells.find((c) => c.id === selectedCellId) ?? null;

  // Computed pixel sizes for display
  const gap = template.gap ?? 0;
  const colPx = resolveTrackSizes(template.columns, template.width, gap);
  const rowPx = resolveTrackSizes(template.rows, template.height, gap);

  // Enforce aspect ratio locks after any template change
  useEffect(() => {
    const constrained = applyAspectRatioConstraints(template);
    if (constrained !== template) {
      onTemplateChange(constrained);
    }
  }, [template, onTemplateChange]);

  // --- Helpers to update template ---

  const updateTemplate = useCallback(
    (partial: Partial<GridTemplate>) => {
      pushUndo();
      onTemplateChange({ ...template, ...partial });
    },
    [template, onTemplateChange, pushUndo],
  );

  const updateCell = useCallback(
    (cellId: string, updates: Partial<GridCell>) => {
      pushUndo();
      onTemplateChange({
        ...template,
        cells: template.cells.map((c) =>
          c.id === cellId ? { ...c, ...updates } : c,
        ),
      });
    },
    [template, onTemplateChange, pushUndo],
  );

  const updateCellContent = useCallback(
    (cellId: string, updates: Partial<CellContent>) => {
      pushUndo();
      onTemplateChange({
        ...template,
        cells: template.cells.map((c) =>
          c.id === cellId
            ? { ...c, content: { ...c.content, ...updates } as CellContent }
            : c,
        ),
      });
    },
    [template, onTemplateChange, pushUndo],
  );

  const addCell = useCallback(() => {
    pushUndo();
    const id = crypto.randomUUID().slice(0, 8);
    const newCell: GridCell = {
      id,
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      content: { type: 'empty' },
    };
    onTemplateChange({
      ...template,
      cells: [...template.cells, newCell],
    });
    setSelectedCellId(id);
  }, [template, onTemplateChange, pushUndo]);

  const deleteCell = useCallback(
    (cellId: string) => {
      pushUndo();
      onTemplateChange({
        ...template,
        cells: template.cells.filter((c) => c.id !== cellId),
      });
      if (selectedCellId === cellId) setSelectedCellId(null);
    },
    [template, onTemplateChange, pushUndo, selectedCellId],
  );

  // --- Track management ---

  const updateTrack = useCallback(
    (axis: 'columns' | 'rows', index: number, track: GridTrackSize) => {
      pushUndo();
      const tracks = [...template[axis]];
      tracks[index] = track;
      onTemplateChange({ ...template, [axis]: tracks });
    },
    [template, onTemplateChange, pushUndo],
  );

  const addTrack = useCallback(
    (axis: 'columns' | 'rows') => {
      pushUndo();
      onTemplateChange({
        ...template,
        [axis]: [...template[axis], { unit: 'fr', value: 1 }],
      });
    },
    [template, onTemplateChange, pushUndo],
  );

  const removeTrack = useCallback(
    (axis: 'columns' | 'rows', index: number) => {
      if (template[axis].length <= 1) return;
      pushUndo();
      const tracks = template[axis].filter((_, i) => i !== index);
      onTemplateChange({ ...template, [axis]: tracks });
    },
    [template, onTemplateChange, pushUndo],
  );

  // --- Image upload ---

  const handleImageUpload = useCallback(
    async (file: File | null, cellId: string) => {
      if (!file) return;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append('image', file);
        const result = await api.uploadOverlay(formData);
        updateCellContent(cellId, { src: result.url } as Partial<CellContent>);
        notifications.show({ title: 'Uploaded', message: 'Image uploaded', color: 'green' });
      } catch (err) {
        notifications.show({ title: 'Upload Error', message: String(err), color: 'red' });
      } finally {
        setUploading(false);
      }
    },
    [updateCellContent],
  );

  return (
    <Card withBorder padding="xs">
      <Group justify="space-between" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
        <Group gap="xs">
          <Text fw={500} size="sm">Edit Layout</Text>
          {isDirty && <Badge size="xs" color="yellow">Unsaved</Badge>}
        </Group>
        <Text size="xs" c="dimmed">{open ? '▲' : '▼'}</Text>
      </Group>

      <Collapse in={open}>
        <Stack gap="sm" mt="sm">
          {/* Grid visual preview */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: colPx.map((px) => `${px}fr`).join(' '),
              gridTemplateRows: rowPx.map((px) => `${px}fr`).join(' '),
              gap: gap,
              width: '100%',
              aspectRatio: `${template.width} / ${template.height}`,
              border: '1px solid var(--mantine-color-dark-4)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            {template.cells.map((cell) => (
              <Box
                key={cell.id}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  setSelectedCellId(cell.id);
                }}
                style={{
                  gridColumn: `${cell.col + 1} / span ${cell.colSpan ?? 1}`,
                  gridRow: `${cell.row + 1} / span ${cell.rowSpan ?? 1}`,
                  backgroundColor: cell.backgroundColor ?? 'rgba(255,255,255,0.05)',
                  border: selectedCellId === cell.id
                    ? '2px solid var(--mantine-color-blue-5)'
                    : '1px solid var(--mantine-color-dark-4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 4,
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                <Text size="xs" ta="center" c="dimmed" truncate>
                  {cell.id}
                  <br />
                  {contentTypeLabel(cell.content.type)}
                </Text>
              </Box>
            ))}
          </Box>

          {/* Grid structure */}
          <Stack gap={4}>
            <Text size="xs" fw={500}>Columns</Text>
            {template.columns.map((track, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <NumberInput
                  size="xs"
                  min={1}
                  value={track.value}
                  onChange={(v) =>
                    updateTrack('columns', i, { ...track, value: Number(v) || 1 })
                  }
                  style={{ flex: 1 }}
                />
                <Select
                  size="xs"
                  data={[
                    { value: 'fr', label: `Proportional${frPercentLabel(template.columns, i) ? ` (${frPercentLabel(template.columns, i)})` : ''}` },
                    { value: 'px', label: 'Fixed' },
                  ]}
                  value={track.unit}
                  onChange={(v) =>
                    updateTrack('columns', i, {
                      unit: (v as 'fr' | 'px') ?? 'fr',
                      value: track.value,
                    })
                  }
                  style={{ width: 160 }}
                />
                <Text size="xs" c="dimmed" style={{ minWidth: 50 }}>
                  {Math.round(colPx[i])}px
                </Text>
                {template.columns.length > 1 && (
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => removeTrack('columns', i)}
                  >
                    ×
                  </ActionIcon>
                )}
              </Group>
            ))}
            <Button size="xs" variant="subtle" onClick={() => addTrack('columns')}>
              + Column
            </Button>
          </Stack>

          <Stack gap={4}>
            <Text size="xs" fw={500}>Rows</Text>
            {template.rows.map((track, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <NumberInput
                  size="xs"
                  min={1}
                  value={track.value}
                  onChange={(v) =>
                    updateTrack('rows', i, { ...track, value: Number(v) || 1 })
                  }
                  style={{ flex: 1 }}
                />
                <Select
                  size="xs"
                  data={[
                    { value: 'fr', label: `Proportional${frPercentLabel(template.rows, i) ? ` (${frPercentLabel(template.rows, i)})` : ''}` },
                    { value: 'px', label: 'Fixed' },
                  ]}
                  value={track.unit}
                  onChange={(v) =>
                    updateTrack('rows', i, {
                      unit: (v as 'fr' | 'px') ?? 'fr',
                      value: track.value,
                    })
                  }
                  style={{ width: 160 }}
                />
                <Text size="xs" c="dimmed" style={{ minWidth: 50 }}>
                  {Math.round(rowPx[i])}px
                </Text>
                {template.rows.length > 1 && (
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => removeTrack('rows', i)}
                  >
                    ×
                  </ActionIcon>
                )}
              </Group>
            ))}
            <Button size="xs" variant="subtle" onClick={() => addTrack('rows')}>
              + Row
            </Button>
          </Stack>

          <Group gap="xs">
            <Text size="xs">Gap:</Text>
            <NumberInput
              size="xs"
              min={0}
              max={50}
              value={template.gap ?? 0}
              onChange={(v) => updateTemplate({ gap: Number(v) || 0 })}
              style={{ width: 80 }}
            />
            <Text size="xs" c="dimmed">px</Text>
          </Group>

          <Group gap="xs">
            <Text size="xs">Background:</Text>
            <ColorInput
              size="xs"
              value={template.backgroundColor}
              onChange={(v) => updateTemplate({ backgroundColor: v })}
              style={{ flex: 1 }}
            />
          </Group>

          <Divider />

          {/* Cell list */}
          <Stack gap={4}>
            <Text size="xs" fw={500}>Cells (draw order)</Text>
            {template.cells.map((cell) => (
              <Group
                key={cell.id}
                gap="xs"
                onClick={() => setSelectedCellId(cell.id)}
                style={{
                  cursor: 'pointer',
                  padding: '2px 6px',
                  borderRadius: 4,
                  backgroundColor:
                    selectedCellId === cell.id
                      ? 'var(--mantine-color-blue-light)'
                      : undefined,
                }}
              >
                <Text size="xs" fw={500} style={{ flex: 1 }}>{cell.id}</Text>
                <Badge size="xs" variant="light">
                  {contentTypeLabel(cell.content.type)}
                </Badge>
                <Text size="xs" c="dimmed">
                  r{cell.row}c{cell.col}
                  {(cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1
                    ? ` (${cell.rowSpan ?? 1}x${cell.colSpan ?? 1})`
                    : ''}
                </Text>
              </Group>
            ))}
            <Button size="xs" variant="light" onClick={addCell}>
              + Add Cell
            </Button>
          </Stack>

          {/* Selected cell editor */}
          {selectedCell ? (
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={500}>Cell: {selectedCell.id}</Text>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() => deleteCell(selectedCell.id)}
                >
                  Delete
                </Button>
              </Group>

              {/* Position & span */}
              <Group gap="xs" grow>
                <NumberInput
                  size="xs"
                  label="Row"
                  min={0}
                  max={template.rows.length - 1}
                  value={selectedCell.row}
                  onChange={(v) => updateCell(selectedCell.id, { row: Number(v) || 0 })}
                />
                <NumberInput
                  size="xs"
                  label="Column"
                  min={0}
                  max={template.columns.length - 1}
                  value={selectedCell.col}
                  onChange={(v) => updateCell(selectedCell.id, { col: Number(v) || 0 })}
                />
                <NumberInput
                  size="xs"
                  label="Row Span"
                  min={1}
                  max={template.rows.length}
                  value={selectedCell.rowSpan ?? 1}
                  onChange={(v) => updateCell(selectedCell.id, { rowSpan: Number(v) || 1 })}
                />
                <NumberInput
                  size="xs"
                  label="Col Span"
                  min={1}
                  max={template.columns.length}
                  value={selectedCell.colSpan ?? 1}
                  onChange={(v) => updateCell(selectedCell.id, { colSpan: Number(v) || 1 })}
                />
              </Group>

              {/* Aspect ratio lock */}
              {(selectedCell.content.type === 'screenShare' ||
                selectedCell.content.type === 'webcam' ||
                selectedCell.content.type === 'image') && (
                <Stack gap={4}>
                  <Text size="xs" fw={500}>Aspect Ratio</Text>
                  <Group gap="xs">
                    {(['16:9', '4:3'] as const).map((ratio) => (
                      <Button
                        key={ratio}
                        size="xs"
                        variant={selectedCell.aspectRatio === ratio ? 'filled' : 'light'}
                        onClick={() =>
                          updateCell(selectedCell.id, {
                            aspectRatio: selectedCell.aspectRatio === ratio ? undefined : ratio,
                          })
                        }
                      >
                        {selectedCell.aspectRatio === ratio ? `Locked ${ratio}` : ratio}
                      </Button>
                    ))}
                  </Group>
                  {selectedCell.aspectRatio && (
                    <Text size="xs" c="dimmed">Row tracks auto-adjusted</Text>
                  )}
                </Stack>
              )}

              {/* Content type */}
              <Select
                size="xs"
                label="Content Type"
                data={CONTENT_TYPE_OPTIONS}
                value={selectedCell.content.type}
                onChange={(v) => {
                  if (v && v !== selectedCell.content.type) {
                    updateCell(selectedCell.id, { content: makeDefaultContent(v) });
                  }
                }}
              />

              {/* Cell background & padding */}
              <Group gap="xs" grow>
                <ColorInput
                  size="xs"
                  label="Cell Background"
                  value={selectedCell.backgroundColor ?? ''}
                  onChange={(v) =>
                    updateCell(selectedCell.id, {
                      backgroundColor: v || undefined,
                    })
                  }
                />
                <NumberInput
                  size="xs"
                  label="Padding"
                  min={0}
                  max={100}
                  value={selectedCell.padding ?? 0}
                  onChange={(v) => updateCell(selectedCell.id, { padding: Number(v) || 0 })}
                />
              </Group>

              {/* Type-specific controls */}
              {selectedCell.content.type === 'text' && (
                <Stack gap="xs">
                  <Textarea
                    size="xs"
                    label="Text Content"
                    autosize
                    minRows={1}
                    maxRows={4}
                    value={selectedCell.content.content}
                    onChange={(e) =>
                      updateCellContent(selectedCell.id, { content: e.currentTarget.value })
                    }
                  />
                  <Group gap="xs" grow>
                    <NumberInput
                      size="xs"
                      label="Font Size"
                      min={8}
                      max={200}
                      value={selectedCell.content.fontSize}
                      onChange={(v) =>
                        updateCellContent(selectedCell.id, { fontSize: Number(v) || 24 })
                      }
                    />
                    <ColorInput
                      size="xs"
                      label="Text Color"
                      value={selectedCell.content.color}
                      onChange={(v) => updateCellContent(selectedCell.id, { color: v })}
                    />
                  </Group>
                  <Group gap="xs" grow>
                    <Stack gap={2}>
                      <Text size="xs">Align</Text>
                      <SegmentedControl
                        size="xs"
                        data={[
                          { value: 'left', label: 'L' },
                          { value: 'center', label: 'C' },
                          { value: 'right', label: 'R' },
                        ]}
                        value={selectedCell.content.align ?? 'left'}
                        onChange={(v) =>
                          updateCellContent(selectedCell.id, {
                            align: v as 'left' | 'center' | 'right',
                          })
                        }
                      />
                    </Stack>
                    <Stack gap={2}>
                      <Text size="xs">Vertical</Text>
                      <SegmentedControl
                        size="xs"
                        data={[
                          { value: 'top', label: 'T' },
                          { value: 'middle', label: 'M' },
                          { value: 'bottom', label: 'B' },
                        ]}
                        value={selectedCell.content.verticalAlign ?? 'top'}
                        onChange={(v) =>
                          updateCellContent(selectedCell.id, {
                            verticalAlign: v as 'top' | 'middle' | 'bottom',
                          })
                        }
                      />
                    </Stack>
                  </Group>
                  <TextInput
                    size="xs"
                    label="Font Family"
                    value={selectedCell.content.fontFamily}
                    onChange={(e) =>
                      updateCellContent(selectedCell.id, {
                        fontFamily: e.currentTarget.value,
                      })
                    }
                  />
                  <TextInput
                    size="xs"
                    label="Font Weight"
                    placeholder="normal, bold, 600..."
                    value={selectedCell.content.fontWeight ?? ''}
                    onChange={(e) =>
                      updateCellContent(selectedCell.id, {
                        fontWeight: e.currentTarget.value || undefined,
                      })
                    }
                  />
                </Stack>
              )}

              {(selectedCell.content.type === 'screenShare' || selectedCell.content.type === 'webcam') && (
                <Select
                  size="xs"
                  label="Video Fit"
                  data={OBJECT_FIT_OPTIONS}
                  value={selectedCell.content.objectFit ?? 'contain'}
                  onChange={(v) =>
                    updateCellContent(selectedCell.id, {
                      objectFit: (v as 'cover' | 'contain' | 'fill') ?? 'contain',
                    })
                  }
                />
              )}

              {selectedCell.content.type === 'image' && (
                <Stack gap="xs">
                  <TextInput
                    size="xs"
                    label="Image URL"
                    value={selectedCell.content.src}
                    onChange={(e) =>
                      updateCellContent(selectedCell.id, { src: e.currentTarget.value })
                    }
                  />
                  <Group gap="xs">
                    <FileButton
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(file) => handleImageUpload(file, selectedCell.id)}
                    >
                      {(props) => (
                        <Button size="xs" variant="light" loading={uploading} {...props}>
                          Upload Image
                        </Button>
                      )}
                    </FileButton>
                    <Select
                      size="xs"
                      label="Fit"
                      data={OBJECT_FIT_OPTIONS}
                      value={selectedCell.content.objectFit ?? 'fill'}
                      onChange={(v) =>
                        updateCellContent(selectedCell.id, {
                          objectFit: (v as 'cover' | 'contain' | 'fill') ?? 'fill',
                        })
                      }
                      style={{ flex: 1 }}
                    />
                  </Group>
                </Stack>
              )}
            </Stack>
          ) : (
            <Text size="xs" c="dimmed" ta="center">
              Select a cell above to edit it
            </Text>
          )}

          <Divider />

          {/* Actions toolbar */}
          <Group justify="space-between">
            <Group gap="xs">
              <Tooltip label="Undo last change">
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={handleUndo}
                  disabled={undoStack.current.length === 0}
                >
                  Undo
                </Button>
              </Tooltip>
              <Button
                size="xs"
                variant="outline"
                color="gray"
                onClick={onReset}
              >
                Reset to Default
              </Button>
            </Group>
            <Button
              size="xs"
              disabled={!isDirty}
              onClick={onSave}
            >
              Save Layout
            </Button>
          </Group>
        </Stack>
      </Collapse>
    </Card>
  );
}
