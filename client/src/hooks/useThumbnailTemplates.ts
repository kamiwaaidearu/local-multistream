import { useCallback, useEffect, useState } from 'react';
import { api, type StoredThumbnailTemplate, type ThumbnailPlate } from '../lib/api';
import { ensureThumbnailFont } from '../lib/thumbnailTemplate';

interface UseThumbnailTemplates {
  templates: StoredThumbnailTemplate[];
  plates: ThumbnailPlate[];
  /** False until both the templates and the brand webfont are ready to draw with. */
  ready: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads the thumbnail templates, the uploaded plates, and the Source Sans 3 webfont.
 *
 * The font load is part of "ready" on purpose: canvas silently falls back to a system sans when a
 * face has not been decoded yet, so rendering before it resolves would produce an off-brand image
 * with no error anywhere to explain it.
 */
export function useThumbnailTemplates(enabled = true): UseThumbnailTemplates {
  const [templates, setTemplates] = useState<StoredThumbnailTemplate[]>([]);
  const [plates, setPlates] = useState<ThumbnailPlate[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [tpls, pls] = await Promise.all([
        api.getThumbnailTemplates(),
        api.getThumbnailPlates(),
        ensureThumbnailFont(),
      ]);
      setTemplates(tpls);
      setPlates(pls);
      setError(null);
      setReady(true);
    } catch (err) {
      setError(String(err));
      setReady(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { templates, plates, ready, error, reload };
}
