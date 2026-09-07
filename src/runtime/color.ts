import {applyTransparency, canonicalColor, rgbColor} from '../base/color';

const color = Symbol('Color');

/**
 * An immutable Tea color with byte channels; alpha 255 is fully opaque.
 * Missing colors are represented by null, never by a partially valid Color.
 * Arrow publishes these own fields as Struct<r:Uint8,g:Uint8,b:Uint8,a:Uint8>.
 *
 * @example
 * ```ts
 * const red = new Color(255, 0, 0);
 * red.toString(); // '#FF0000'
 * red.equals(Color.parse('#ff0000ff')); // true
 * red.withTransparency(100).a; // 0; red is unchanged
 * ```
 */
export class Color {
  declare readonly [color]: void;

  /** Round and clamp finite channels to bytes. Alpha defaults to opaque. */
  constructor(
    public readonly r: number,
    public readonly g: number,
    public readonly b: number,
    public readonly a = 255,
  ) {
    if (![r, g, b, a].every(Number.isFinite))
      throw new TypeError('color channels must be finite numbers');
    this.r = Math.max(0, Math.min(255, Math.round(r)));
    this.g = Math.max(0, Math.min(255, Math.round(g)));
    this.b = Math.max(0, Math.min(255, Math.round(b)));
    this.a = Math.max(0, Math.min(255, Math.round(a)));
    Object.freeze(this);
  }

  /**
   * Parse the hex representation accepted by Tea color parameters and literals.
   * Invalid input throws; callers represent a missing color with null.
   * @example `Color.parse('#2196f380').a` is 128.
   */
  static parse(value: string): Color {
    const hex = canonicalColor(value);
    if (hex === null) throw new TypeError('color must be #RRGGBB or #RRGGBBAA');
    return new Color(
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255,
    );
  }

  /**
   * Construct a color with Tea's transparency percentage and rounding rules.
   * @example `Color.rgb(300, -5, 127.6, 100).toString()` is '#FF008000'.
   */
  static rgb(r: number, g: number, b: number, transparency = 0): Color {
    return new Color(r, g, b).withTransparency(transparency);
  }

  /**
   * Replace transparency, clamping the percentage to 0 through 100.
   * @example `Color.parse('#FF000080').withTransparency(0).toString()` is '#FF0000'.
   */
  withTransparency(value: number): Color {
    if (!Number.isFinite(value))
      throw new TypeError('color transparency must be a finite number');
    return Color.parse(applyTransparency(this.toString(), value));
  }

  /** Compare channel values; separately constructed equal colors are equal. */
  equals(other: Color | null): boolean {
    return (
      other !== null &&
      this.r === other.r &&
      this.g === other.g &&
      this.b === other.b &&
      this.a === other.a
    );
  }

  /** Format canonical uppercase hex, omitting alpha when fully opaque. */
  toString(): string {
    const rgb = rgbColor(this.r, this.g, this.b, null);
    return this.a === 255
      ? rgb
      : rgb + this.a.toString(16).padStart(2, '0').toUpperCase();
  }
}
