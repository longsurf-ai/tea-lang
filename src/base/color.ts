// Color arithmetic and canonical hex shared by folding, binding and runtime values.

// The canonical encoding: fully-opaque colors are 6-digit '#RRGGBB', partial
// transparency is 8-digit '#RRGGBBAA' — one color, one string, so tea's
// string equality matches Pine's color equality (color.rgb(r,g,b) ==
// color.rgb(r,g,b,0)). Inputs outside the domain clamp here; CONST
// arguments are additionally rejected by the checker (loud, Pine parity).
// na handling lives at the call boundaries (folders propagate NA_VALUE,
// runtime helpers return null) — these formulas see valid numbers only.

/**
 * Normalize a Tea color's hex spelling so equal channels have equal strings.
 * Invalid input returns null; opaque alpha is omitted.
 * @example `canonicalColor('#ff0000ff')` is '#FF0000'.
 */
export function canonicalColor(value: string): string | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (match === null) return null;
  const base = `#${match[1].toUpperCase()}`;
  const alpha = match[2]?.toUpperCase();
  return alpha === undefined || alpha === 'FF' ? base : `${base}${alpha}`;
}

// '#RRGGBB' | '#RRGGBBAA' with transparency 0..100 → canonical hex.
export function applyTransparency(color: string, transp: number): string {
  const clamped = Math.max(0, Math.min(100, transp));
  const base = color.slice(0, 7);
  if (clamped === 0) {
    return base;
  }
  const alpha = Math.round((100 - clamped) * 2.55)
    .toString(16)
    .toUpperCase();
  return alpha === 'FF' ? base : base + alpha.padStart(2, '0');
}

// color.rgb(r, g, b, transp = 0) → canonical hex.
export function rgbColor(
  r: number,
  g: number,
  b: number,
  transp: number | null,
): string {
  const hex = (x: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(x)));
    const digits = clamped.toString(16).toUpperCase();
    return digits.length < 2 ? `0${digits}` : digits;
  };
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return transp === null ? base : applyTransparency(base, transp);
}
