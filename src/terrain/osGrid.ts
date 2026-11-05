/**
 * Ordnance Survey grid references (pure): "NN 166 712" → eastings/northings in metres, and OS grid positions →
 * latitude/longitude on WGS84 (what web maps and the free height tiles use). The maths is the Ordnance Survey's own
 * ("A guide to coordinate systems in Great Britain"): transverse Mercator on the Airy 1830 ellipsoid, then a
 * seven-parameter Helmert shift from OSGB36 to WGS84 — good to about 5 m, far finer than a printed puzzle shows.
 */

export interface GridPoint {
  /** Metres east of the grid's false origin. */
  e: number;
  /** Metres north. */
  n: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

const LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // no I

/**
 * Read a grid reference: two letters and 2–10 digits ("NN1667", "NN 166 712", "nn16667 71283"), or plain eastings and
 * northings in metres ("216667, 771283"). Returns null when it isn't one. The point is the square's south-west corner,
 * as on the map; a 6-figure reference is a 100 m square.
 */
export function parseGridRef(text: string): GridPoint | null {
  const t = text.trim().toUpperCase();
  const plain = t.match(/^(\d{1,7}(?:\.\d+)?)\s*[,\s]\s*(\d{1,7}(?:\.\d+)?)$/);
  if (plain) {
    const e = Number(plain[1]);
    const n = Number(plain[2]);
    return e <= 700000 && n <= 1300000 ? { e, n } : null;
  }
  const m = t.match(/^([A-HJ-Z])([A-HJ-Z])\s*([\d\s]*)$/);
  if (!m) return null;
  const digits = m[3].replace(/\s+/g, "");
  if (digits.length % 2 !== 0 || digits.length > 10) return null;
  const l1 = LETTERS.indexOf(m[1]);
  const l2 = LETTERS.indexOf(m[2]);
  // The first letter is a 500 km square (S is the one with the false origin at its corner), the second a 100 km one.
  const e100 = (((l1 - 2) % 5) + 5) % 5 * 5 + (l2 % 5);
  const n100 = 19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null;
  const half = digits.length / 2;
  const scale = 10 ** (5 - half);
  const e = half ? Number(digits.slice(0, half)) * scale : 0;
  const n = half ? Number(digits.slice(half)) * scale : 0;
  return { e: e100 * 100000 + e, n: n100 * 100000 + n };
}

/** A grid position as a 10-figure reference, "NN 16667 71283" (null off the grid). */
export function formatGridRef(p: GridPoint, figures = 10): string | null {
  const e100 = Math.floor(p.e / 100000);
  const n100 = Math.floor(p.n / 100000);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null;
  let l1 = 19 - n100 - ((19 - n100) % 5) + Math.floor((e100 + 10) / 5);
  let l2 = (((19 - n100) * 5) % 25) + (e100 % 5);
  if (l1 > 7) l1++;
  if (l2 > 7) l2++;
  const letters = String.fromCharCode(65 + l1) + String.fromCharCode(65 + l2);
  const half = figures / 2;
  const div = 10 ** (5 - half);
  const e = String(Math.floor((p.e % 100000) / div)).padStart(half, "0");
  const n = String(Math.floor((p.n % 100000) / div)).padStart(half, "0");
  return `${letters} ${e} ${n}`;
}

const rad = Math.PI / 180;

/** OSGB36 eastings/northings → latitude/longitude on the Airy 1830 ellipsoid (radians). */
function gridToOsgb36(p: GridPoint): { lat: number; lon: number } {
  const a = 6377563.396;
  const b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = 49 * rad;
  const lon0 = -2 * rad;
  const N0 = -100000;
  const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const [n2, n3] = [n * n, n * n * n];
  let lat = lat0;
  let M = 0;
  do {
    lat = (p.n - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(p.n - N0 - M) >= 0.00001);
  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const tan = Math.tan(lat);
  const [t2, t4, t6] = [tan * tan, tan ** 4, tan ** 6];
  const sec = 1 / cos;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = p.e - E0;
  return {
    lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon: lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  };
}

/** An OS grid position → latitude/longitude on WGS84, degrees. */
export function gridToLatLon(p: GridPoint): LatLon {
  const { lat, lon } = gridToOsgb36(p);
  // To cartesian on Airy 1830 (height 0)…
  const a1 = 6377563.396;
  const b1 = 6356256.909;
  const e1 = 1 - (b1 * b1) / (a1 * a1);
  const nu1 = a1 / Math.sqrt(1 - e1 * Math.sin(lat) ** 2);
  const x1 = nu1 * Math.cos(lat) * Math.cos(lon);
  const y1 = nu1 * Math.cos(lat) * Math.sin(lon);
  const z1 = (1 - e1) * nu1 * Math.sin(lat);
  // …Helmert OSGB36 → WGS84…
  const [tx, ty, tz] = [446.448, -125.157, 542.06];
  const s = -20.4894e-6;
  const sec = rad / 3600;
  const [rx, ry, rz] = [0.1502 * sec, 0.247 * sec, 0.8421 * sec];
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
  // …back to latitude/longitude on WGS84.
  const a2 = 6378137;
  const b2 = 6356752.314245;
  const e2 = 1 - (b2 * b2) / (a2 * a2);
  const pxy = Math.hypot(x2, y2);
  let phi = Math.atan2(z2, pxy * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const nu2 = a2 / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(z2 + e2 * nu2 * Math.sin(phi), pxy);
  }
  return { lat: phi / rad, lon: Math.atan2(y2, x2) / rad };
}
