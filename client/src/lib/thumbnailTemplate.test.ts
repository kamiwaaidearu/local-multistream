import { describe, it, expect } from 'vitest';
import {
  ordinal,
  formatThumbnailDate,
  applyTokens,
  wrapText,
  layoutElement,
  layoutThumbnail,
  parseNumericField,
  thumbnailFilename,
  type ThumbnailTextElement,
  type MeasureText,
} from './thumbnailTemplate';

/**
 * A stand-in for canvas text measurement: every glyph is 0.5em wide. jsdom has no real text
 * metrics, and the layout maths is what these tests are about — a proportional-but-predictable
 * measure exercises wrapping and shrink-to-fit exactly like the real one would.
 */
const measure: MeasureText = (text, font, letterSpacingEm) => {
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
  return text.length * size * (0.5 + letterSpacingEm);
};

function element(overrides: Partial<ThumbnailTextElement> = {}): ThumbnailTextElement {
  return {
    id: 'main',
    label: 'Title',
    text: 'Hello',
    editable: true,
    x: 0.5,
    y: 0.9,
    maxWidth: 0.8,
    maxLines: 2,
    align: 'center',
    vAlign: 'bottom',
    fontSize: 0.1,
    fontWeight: 700,
    italic: false,
    uppercase: false,
    color: '#ffffff',
    lineHeight: 1,
    letterSpacing: 0,
    ...overrides,
  };
}

describe('ordinal', () => {
  it('uses the right suffix for the common cases', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(19)).toBe('19th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(31)).toBe('31st');
  });

  it('handles the 11/12/13 exceptions that break the mod-10 rule', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
  });
});

describe('formatThumbnailDate', () => {
  const date = new Date(2026, 7, 19); // 19 August 2026, a Wednesday

  it('matches the long form used on the existing thumbnails', () => {
    expect(formatThumbnailDate(date, 'long')).toBe('August 19th, 2026');
  });

  it('supports short and weekday forms', () => {
    expect(formatThumbnailDate(date, 'short')).toBe('Aug 19th');
    expect(formatThumbnailDate(date, 'weekday')).toBe('Wednesday, August 19th');
  });
});

describe('applyTokens', () => {
  const vars = { title: 'Luminous Mysteries', date: new Date(2026, 7, 19) };

  it('substitutes title and date', () => {
    expect(applyTokens('{{title}}\n{{date}}', vars)).toBe('Luminous Mysteries\nAugust 19th, 2026');
  });

  it('honours a date style argument and tolerates surrounding whitespace', () => {
    expect(applyTokens('{{ date:short }}', vars)).toBe('Aug 19th');
  });

  it('leaves an unknown token verbatim so the typo is visible in the preview', () => {
    expect(applyTokens('{{mystery}}', vars)).toBe('{{mystery}}');
  });

  it('renders missing values as empty rather than the literal token', () => {
    expect(applyTokens('{{title}}|{{date}}', {})).toBe('|');
  });
});

describe('wrapText', () => {
  const m = (s: string) => s.length * 10;

  it('breaks on words once a line would overflow', () => {
    expect(wrapText('one two three', 70, m)).toEqual(['one two', 'three']);
  });

  it('always honours explicit newlines', () => {
    expect(wrapText('a\nb', 1000, m)).toEqual(['a', 'b']);
  });

  it('leaves an unbreakable word overflowing on its own line', () => {
    expect(wrapText('supercalifragilistic', 50, m)).toEqual(['supercalifragilistic']);
  });
});

describe('layoutElement', () => {
  const vars = { title: 'Luminous Mysteries', date: new Date(2026, 7, 19) };

  it('anchors a bottom-aligned block so it grows upward, not down over the frame edge', () => {
    const oneLine = layoutElement(element({ text: 'A' }), vars, 1280, 720, measure);
    const twoLine = layoutElement(element({ text: 'A\nB' }), vars, 1280, 720, measure);

    // The last baseline stays put; the extra line appears above it.
    const lastOf = (l: typeof oneLine) => l.lines[l.lines.length - 1].y;
    expect(lastOf(twoLine)).toBeCloseTo(lastOf(oneLine), 5);
    expect(twoLine.lines[0].y).toBeLessThan(twoLine.lines[1].y);
  });

  it('keeps the designed size when the text fits', () => {
    const laid = layoutElement(element({ text: 'Short' }), vars, 1280, 720, measure);
    expect(laid.fontSizePx).toBeCloseTo(72, 5); // 0.1 * 720
    expect(laid.shrunk).toBe(false);
  });

  it('shrinks, and reports shrinking, when a long title will not fit its line budget', () => {
    const laid = layoutElement(
      element({ text: 'The Glorious Mysteries of the Most Holy Rosary in Latin', maxLines: 1 }),
      vars,
      1280,
      720,
      measure,
    );
    expect(laid.shrunk).toBe(true);
    expect(laid.fontSizePx).toBeLessThan(72);
  });

  it('stops shrinking at the legibility floor instead of producing unreadable text', () => {
    const laid = layoutElement(
      element({ text: 'x'.repeat(400), maxLines: 1 }),
      vars,
      1280,
      720,
      measure,
    );
    // 55% of the designed 72px. It overflows, but it is flagged rather than silently microscopic.
    expect(laid.fontSizePx).toBeCloseTo(72 * 0.55, 5);
    expect(laid.shrunk).toBe(true);
  });

  it('wraps into the allowed number of lines before it resorts to shrinking', () => {
    const laid = layoutElement(
      element({ text: 'Luminous Mysteries in Latin', maxLines: 2, fontSize: 0.06, maxWidth: 0.4 }),
      vars,
      1280,
      720,
      measure,
    );
    expect(laid.lines.length).toBeGreaterThan(1);
    expect(laid.shrunk).toBe(false);
  });

  it('applies uppercase and token substitution before measuring', () => {
    const laid = layoutElement(element({ text: '{{title}}', uppercase: true }), vars, 1280, 720, measure);
    expect(laid.lines.map((l) => l.text).join(' ')).toBe('LUMINOUS MYSTERIES');
  });

  it('scales geometry with the canvas so 1920x1080 matches 1280x720', () => {
    const small = layoutElement(element(), vars, 1280, 720, measure);
    const large = layoutElement(element(), vars, 1920, 1080, measure);
    expect(large.fontSizePx / small.fontSizePx).toBeCloseTo(1.5, 5);
    expect(large.lines[0].x / small.lines[0].x).toBeCloseTo(1.5, 5);
    expect(large.lines[0].y / small.lines[0].y).toBeCloseTo(1.5, 5);
  });
});

describe('layoutThumbnail — linked shrinking', () => {
  const vars = { title: 'The Sorrowful Mysteries of the Most Holy Rosary', date: new Date(2026, 8, 30) };

  /** The seeded shape: an 88px title with a 70px sub text pinned to it. */
  function template(subScaleWith: string | null) {
    return {
      id: 't',
      name: 'T',
      backgroundColor: '#0d4d8c',
      plate: null,
      elements: [
        element({ id: 'main', text: '{{title}}', maxLines: 1, fontSize: 88 / 720 }),
        element({ id: 'sub', text: '{{date}}', maxLines: 1, fontSize: 70 / 720, scaleWith: subScaleWith }),
      ],
    };
  }

  it('keeps the title/sub size ratio when a long title shrinks', () => {
    const [main, sub] = layoutThumbnail(template('main'), vars, 1280, 720, measure);
    expect(main.shrunk).toBe(true);
    expect(sub.fontSizePx / main.fontSizePx).toBeCloseTo(70 / 88, 5);
  });

  it('leaves the sub text at full size when it is not linked', () => {
    const [main, sub] = layoutThumbnail(template(null), vars, 1280, 720, measure);
    expect(main.shrunk).toBe(true);
    expect(sub.fontSizePx).toBeCloseTo(70, 5); // 70/720 * 720
    // The whole point of the linkage: unlinked, the date ends up BIGGER than the title.
    expect(sub.fontSizePx).toBeGreaterThan(main.fontSizePx);
  });

  it('does not flag a follower as shrunk — only the element the operator must shorten', () => {
    const [main, sub] = layoutThumbnail(template('main'), vars, 1280, 720, measure);
    expect(main.shrunk).toBe(true);
    expect(sub.shrunk).toBe(false);
  });

  it('leaves both at designed size when the title fits', () => {
    const [main, sub] = layoutThumbnail(
      template('main'),
      { title: 'Luminous Mysteries', date: new Date(2026, 7, 19) },
      1280,
      720,
      measure,
    );
    expect(main.shrunk).toBe(false);
    expect(main.fontSizePx).toBeCloseTo(88, 5);
    expect(sub.fontSizePx).toBeCloseTo(70, 5);
  });

  it('degrades to no linkage on a dangling reference', () => {
    const [, sub] = layoutThumbnail(template('nope'), vars, 1280, 720, measure);
    expect(sub.fontSizePx).toBeCloseTo(70, 5);
  });

  it('settles instead of recursing when two elements point at each other', () => {
    const tpl = {
      id: 't',
      name: 'T',
      backgroundColor: '#0d4d8c',
      plate: null,
      elements: [
        element({ id: 'a', text: 'A', scaleWith: 'b' }),
        element({ id: 'b', text: 'B', scaleWith: 'a' }),
      ],
    };
    const laid = layoutThumbnail(tpl, vars, 1280, 720, measure);
    expect(laid.map((l) => l.fitScale)).toEqual([1, 1]);
  });
});

describe('parseNumericField', () => {
  it('rejects an empty field instead of coercing it to zero', () => {
    // The bug this guards: Number('') is 0, so clearing the Font size input wrote 0, blanked the
    // line out of the preview, and persisted that on the next Save.
    expect(parseNumericField('', 0.01, 0.4)).toBeNull();
    expect(parseNumericField(null, 0.01, 0.4)).toBeNull();
    expect(parseNumericField(undefined, 0.01, 0.4)).toBeNull();
    expect(parseNumericField('-', 0.01, 0.4)).toBeNull();
    expect(parseNumericField(NaN, 0.01, 0.4)).toBeNull();
  });

  it('accepts real numbers, from either a string or a number', () => {
    expect(parseNumericField('0.09', 0.01, 0.4)).toBeCloseTo(0.09, 5);
    expect(parseNumericField(0.09, 0.01, 0.4)).toBeCloseTo(0.09, 5);
  });

  it('clamps to the field range rather than storing something unrenderable', () => {
    expect(parseNumericField(5, 0.01, 0.4)).toBeCloseTo(0.4, 5);
    expect(parseNumericField(-3, 0.01, 0.4)).toBeCloseTo(0.01, 5);
    expect(parseNumericField(0, 1, 6)).toBe(1); // maxLines: 0 would disable the fit check entirely
  });
});

describe('thumbnailFilename', () => {
  it('slugifies a title', () => {
    expect(thumbnailFilename('Luminous Mysteries — Aug 19')).toBe('luminous-mysteries-aug-19.jpg');
  });

  it('falls back for a title with nothing usable in it', () => {
    expect(thumbnailFilename('!!!')).toBe('thumbnail.jpg');
  });
});
