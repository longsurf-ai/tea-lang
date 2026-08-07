// Purpose: Color value arithmetic shared by compile-time folding and the runtime emitter contract — the single owner of the hex+alpha encoding; codegen's emitted $colorNew helper mirrors these formulas (parity-locked by test).

// '#RRGGBB' | '#RRGGBBAA' with transparency 0..100 → '#RRGGBBAA'.
export function applyTransparency(color: string, transp: number): string {
  const alpha = Math.round((100 - transp) * 2.55)
    .toString(16)
    .toUpperCase();
  return color.slice(0, 7) + (alpha.length < 2 ? `0${alpha}` : alpha);
}

// color.rgb(r, g, b, transp?) → '#RRGGBB' or '#RRGGBBAA'.
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
