export type QualityRegion = 'thick' | 'wideInk' | 'fine' | 'punctuation' | 'paper' | 'darkShadow' | 'midShadow';

export interface FilterQualityFixture {
  readonly image: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray };
  readonly samples: Readonly<Record<QualityRegion, readonly number[]>>;
}

interface Layout { readonly width: number; readonly height: number; readonly margin: number }

/** Deliberately document-like pixels, built without filter constants or threshold math. */
export function createFilterQualityFixture({ width, height, margin }: Layout): FilterQualityFixture {
  const data = new Uint8ClampedArray(width * height * 4);
  const samples = {} as Record<QualityRegion, number[]>;
  const px = (x: number, y: number) => y * width + x;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const paper = 228 + ((x * 17 + y * 11) % 9) + Math.round((y / height) * 13);
    const offset = px(x, y) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = paper;
    data[offset + 3] = 255;
  }
  const sx = (value: number) => Math.round((margin + value * (1 - margin * 2)) * width);
  const sy = (value: number) => Math.round((margin + value * (1 - margin * 2)) * height);
  const paint = (x0: number, y0: number, x1: number, y1: number, value: number, alpha = 1) => {
    for (let y = Math.max(0, sy(y0)); y < Math.min(height, sy(y1)); y += 1) for (let x = Math.max(0, sx(x0)); x < Math.min(width, sx(x1)); x += 1) {
      const offset = px(x, y) * 4;
      const mixed = Math.round((data[offset] ?? 255) * (1 - alpha) + value * alpha);
      data[offset] = data[offset + 1] = data[offset + 2] = mixed;
    }
  };
  const mark = (name: QualityRegion, x0: number, y0: number, x1: number, y1: number) => {
    const points = samples[name] ?? (samples[name] = []);
    for (let y = sy(y0); y < sy(y1); y += 1) for (let x = sx(x0); x < sx(x1); x += 1) points.push(px(x, y));
  };

  // Bounded illumination defects leave clear textured paper around each shadow.
  paint(0.06, 0.16, 0.22, 0.34, 54, 0.9); mark('darkShadow', 0.08, 0.19, 0.19, 0.31);
  paint(0.74, 0.62, 0.91, 0.81, 160, 0.86); mark('midShadow', 0.77, 0.65, 0.88, 0.78);
  mark('paper', 0.31, 0.08, 0.66, 0.15);

  // Filled title glyph and a genuinely wider black ink bar; edges are anti-aliased.
  paint(0.30, 0.23, 0.34, 0.49, 0); paint(0.43, 0.23, 0.47, 0.49, 0); paint(0.34, 0.33, 0.43, 0.39, 0);
  paint(0.55, 0.22, 0.64, 0.50, 0); paint(0.548, 0.218, 0.642, 0.502, 0, 0.35);
  mark('thick', 0.305, 0.27, 0.335, 0.45); mark('wideInk', 0.565, 0.25, 0.625, 0.47);
  // Fine ruled writing plus disconnected punctuation: each probe samples intended ink, not its background.
  for (const y of [0.58, 0.64, 0.70]) { paint(0.28, y, 0.68, y + 0.006, 0); mark('fine', 0.32, y, 0.64, y + 0.006); }
  const punctuation: readonly (readonly [number, number])[] = [[0.32, 0.78], [0.40, 0.80], [0.49, 0.77], [0.59, 0.81]];
  for (const [x, y] of punctuation) { paint(x, y, x + 0.012, y + 0.012, 0); mark('punctuation', x, y, x + 0.012, y + 0.012); }
  return { image: { width, height, data }, samples };
}
