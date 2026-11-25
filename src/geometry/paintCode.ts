/**
 * Bambu Studio's `paint_color` for a whole (unsplit) triangle painted with filament `n` — TriangleSelector's bits
 * (2 bits of split sides = 0, then the state: 2 bits, or 0b11 and 4-bit nibbles of n − 3) as hex digits, last first:
 * 1 → "4", 2 → "8", 3 → "0C", 4 → "1C", … 17 → "EC", 18 → "0FC", 19 → "1FC" (BambuStudio src/libslic3r/TriangleSelector.cpp serialize,
 * Model.cpp FacetsAnnotation::get_triangle_as_string).
 */
export function paintCode(n: number): string {
  if (n <= 0) return "";
  const bits: number[] = [0, 0];
  if (n < 3) bits.push(n & 1, (n >> 1) & 1);
  else {
    bits.push(1, 1);
    let r = n - 3;
    while (r >= 15) bits.push(1, 1, 1, 1), (r -= 15);
    for (let b = 0; b < 4; b++) bits.push((r >> b) & 1);
  }
  while (bits.length % 4) bits.push(0);
  let out = "";
  for (let i = 0; i < bits.length; i += 4) out = (bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3)).toString(16).toUpperCase() + out;
  return out;
}
