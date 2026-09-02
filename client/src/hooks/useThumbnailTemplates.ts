import { useCallback, useEffect, useState } from 'react';
import { api, type StoredThumbnailTemplate, type ThumbnailPlate } from '../lib/api';
import { ensureThumbnailFont } from '../lib/thumbnailTemplate';

interface UseThumbnailTemplates {
  templates: StoredThumbnailTemplate[];
  plates: ThumbnailPlate[];
  /** True once the templates are loaded and it is safe to render. */
  ready: boolean;
  /** Set when the templates could NOT be loaded. Callers must surface this and must not quietly
   *  carry on producing thumbnail-less streams. */
  error: string | null;
  /** Set when the brand webfont did not load. Rendering still works — in a fallback typeface — so
   *  this is a warning, not a failure. */
  fontWarning: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads the thumbnail templates, the uploaded plates, and the Source Sans 3 webfont.
 *
 * The font is loaded SEPARATELY from the data on purpose. It used to share a `Promise.all` with the
 * two fetches, which meant one missing font file rejected the whole thing and threw away templates
 * that had loaded perfectly well — turning an off-brand-typeface problem into a dead feature. A font
 * failure now degrades to a warning; only a data failure sets `error`.
 */
export function useThumbnailTemplates(enabled = true): UseThumbnailTemplates {
  const [templates, setTemplates] = useState<StoredThumbnailTemplate[]>([]);
  const [plates, setPlates] = useState<ThumbnailPlate[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontWarning, setFontWarning] = useState<string | null>(null);

  const reload = useCallback(async () => {
    // The font never rejects the load; at worst it reports that it could not be decoded.
    void ensureThumbnailFont()
      .then((ok) =>
        setFontWarning(
          ok
            ? null
            : 'The Source Sans 3 webfont could not be loaded, so thumbnails will render in a fallback typeface. Rebuilding the client (npm run build) usually fixes this.',
        ),
      )
      .catch(() => setFontWarning('The Source Sans 3 webfont could not be loaded.'));

    try {
      const [tpls, pls] = await Promise.all([api.getThumbnailTemplates(), api.getThumbnailPlates()]);
      setTemplates(tpls);
      setPlates(pls);
      setError(null);
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReady(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { templates, plates, ready, error, fontWarning, reload };
}
