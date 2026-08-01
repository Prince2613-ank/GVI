/** Excess Green index: 2G - R - B, on 0-255 channel values. Higher = more dominantly green. */
export function excessGreen(r: number, g: number, b: number): number {
  return 2 * g - r - b;
}

/** G / (R + G + B) — green's share of total brightness, independent of overall exposure. */
export function greenRatio(r: number, g: number, b: number): number {
  const sum = r + g + b;
  return sum === 0 ? 0 : g / sum;
}
