// WCAG contrast for the OKLCH colours the tokens are written in (UI-01 §4.2). OKLCH → OKLab → linear sRGB
// (Björn Ottosson's matrices), clipped to the sRGB gamut as a browser would display it. Translucent
// colours are composited over their backdrop in gamma-encoded sRGB, as browsers do.

export type Rgba = { r: number; g: number; b: number; a: number }; // gamma-encoded sRGB, 0..1

const OKLCH_RE = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/;

const encode = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Parses `oklch(L C H)` or `oklch(L C H / A)` (L and A as a number or a percentage). */
export function parseOklch(css: string): Rgba {
  const m = OKLCH_RE.exec(css.trim());
  if (!m) throw new Error(`not an oklch() colour: ${css}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    a: alpha,
  };
}

/** `top` painted over an opaque `backdrop`. */
export function over(top: Rgba, backdrop: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, backdrop.r), g: mix(top.g, backdrop.g), b: mix(top.b, backdrop.b), a: 1 };
}

/** A colour at a given opacity (Tailwind's `bg-destructive/10`). */
export const withAlpha = (c: Rgba, alpha: number): Rgba => ({ ...c, a: c.a * alpha });

export const luminance = (c: Rgba) => 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b);

/** WCAG 2 contrast ratio, 1..21. Both colours must be opaque (composite translucent ones first). */
export function contrast(x: Rgba, y: Rgba): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
