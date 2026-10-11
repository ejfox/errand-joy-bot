// Board size from a Gerber zip, for the OSH Park adapter (and tools/pcb/gerber_bbox.ts, its CLI).
// No dependencies: a minimal zip reader (stored + deflate entries, via DecompressionStream) and a
// Gerber RS-274X reader that only follows the outline layer's draw/move coordinates and arcs.
//
// OSH Park bills the rectangular bounding box of the board outline, so this returns W × H of the
// outline's geometry (centerline; aperture width ignored, as KiCad's Edge.Cuts is the board edge).

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export class GerberError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GerberError";
  }
}

const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read every file entry of a zip (central directory → local headers). Stored and deflate only. */
export async function readZip(zip: Uint8Array): Promise<ZipEntry[]> {
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new GerberError("zip_invalid");
  const count = u16(zip, eocd + 10);
  if (count > MAX_ENTRIES) throw new GerberError("zip_too_many_entries");
  let p = u32(zip, eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(zip, p) !== 0x02014b50) throw new GerberError("zip_invalid");
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const size = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory
    if (size > MAX_ENTRY_BYTES || compSize > MAX_ENTRY_BYTES) throw new GerberError("zip_entry_too_large");
    if (local + 30 > zip.length || u32(zip, local) !== 0x04034b50) throw new GerberError("zip_invalid");
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const data = zip.subarray(start, start + compSize);
    if (data.length !== compSize) throw new GerberError("zip_truncated");
    let bytes: Uint8Array;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = await inflateRaw(data);
    else throw new GerberError("zip_unsupported_compression");
    if (bytes.length > MAX_ENTRY_BYTES) throw new GerberError("zip_entry_too_large");
    out.push({ name, bytes });
  }
  return out;
}

/** Filename hints for the outline layer, most specific first (KiCad, Altium/Protel, Eagle). */
const OUTLINE_NAME_PATTERNS: RegExp[] = [
  /edge[._-]?cuts/i,
  /\.gko$/i, // Altium/Eagle keep-out / board outline
  /\.gm1$/i, // Altium mechanical 1
  /\.gml$/i, // Eagle milling
  /(^|[^a-z])outline([^a-z]|$)/i,
];

/**
 * Pick the board outline from the zip. A Gerber X2 `%TF.FileFunction,Profile` attribute (KiCad
 * writes it) wins; otherwise the first filename match in OUTLINE_NAME_PATTERNS order.
 */
export function findOutline(entries: ZipEntry[]): { name: string; text: string } {
  const dec = new TextDecoder();
  const files = entries.filter((e) => !/(^|\/)(__MACOSX|\.)/.test(e.name));
  for (const e of files) {
    const head = dec.decode(e.bytes.subarray(0, 4096));
    if (/%TF\.FileFunction,Profile[,*]/.test(head)) return { name: e.name, text: dec.decode(e.bytes) };
  }
  for (const re of OUTLINE_NAME_PATTERNS) {
    const e = files.find((f) => re.test(f.name.split("/").pop() ?? f.name));
    if (e) return { name: e.name, text: dec.decode(e.bytes) };
  }
  throw new GerberError("gerber_outline_not_found");
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box (in mm) of every D01 draw in a Gerber outline. Follows %FS (leading-zero omission,
 * absolute), %MO units, modal coordinates, G01/G02/G03 and G75 arcs (axis extremes included, so a
 * rounded corner isn't under-sized). D02 moves alone don't extend the box.
 */
export function gerberBboxMm(text: string): Bbox {
  let xInt = 0, xDec = 0, yInt = 0, yDec = 0, trailing = false;
  let fsSeen = false;
  let unit: "mm" | "in" | undefined;
  let mode: "lin" | "cw" | "ccw" = "lin";
  let multi = false; // G75 multi-quadrant; G74 single-quadrant (I/J unsigned)
  let x = 0, y = 0;
  const box: Bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (px: number, py: number) => {
    box.minX = Math.min(box.minX, px);
    box.maxX = Math.max(box.maxX, px);
    box.minY = Math.min(box.minY, py);
    box.maxY = Math.max(box.maxY, py);
  };

  const num = (s: string, intDigits: number, decDigits: number): number => {
    const neg = s.startsWith("-");
    let d = s.replace(/^[+-]/, "");
    if (d.includes(".")) return (neg ? -1 : 1) * Number(d); // explicit decimal point (allowed by some writers)
    if (trailing) d = d.padEnd(intDigits + decDigits, "0");
    const v = Number(d) / 10 ** decDigits;
    return neg ? -v : v;
  };

  // Split into extended (%...%) and word (...*) commands.
  const tokens = text.replace(/\r/g, "").match(/%[^%]*%|[^%*]+\*/g) ?? [];
  for (const raw of tokens) {
    const t = raw.trim().replace(/\s+/g, "");
    if (t.startsWith("%")) {
      const body = t.slice(1, -1);
      const fs = /^FS([LT])A?X(\d)(\d)Y(\d)(\d)\*/.exec(body);
      if (fs) {
        trailing = fs[1] === "T";
        [xInt, xDec, yInt, yDec] = [fs[2], fs[3], fs[4], fs[5]].map(Number);
        fsSeen = true;
        if (/^FS[LT]I/.test(body)) throw new GerberError("gerber_incremental_unsupported");
      } else if (/^FS[LT]I/.test(body)) {
        throw new GerberError("gerber_incremental_unsupported");
      }
      if (/^MOMM\*/.test(body)) unit = "mm";
      if (/^MOIN\*/.test(body)) unit = "in";
      continue;
    }
    let w = t.slice(0, -1);
    if (/^G0?4(?!\d)/.test(w)) continue; // comment
    if (w === "G70") unit = "in"; // deprecated unit codes
    if (w === "G71") unit = "mm";
    if (w === "G74") multi = false;
    if (w === "G75") multi = true;
    const g = /^G0?([123])(?!\d)/.exec(w);
    if (g) {
      mode = g[1] === "1" ? "lin" : g[1] === "2" ? "cw" : "ccw";
      w = w.slice(g[0].length);
    }
    const m = /^(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?D0?([123])$/.exec(w);
    if (!m) continue;
    if (!fsSeen && (m[1] || m[2])) throw new GerberError("gerber_no_format");
    const nx = m[1] !== undefined ? num(m[1], xInt, xDec) : x;
    const ny = m[2] !== undefined ? num(m[2], yInt, yDec) : y;
    const op = m[5];
    if (op === "1") {
      add(x, y);
      add(nx, ny);
      if (mode !== "lin") {
        const i = m[3] !== undefined ? num(m[3], xInt, xDec) : 0;
        const j = m[4] !== undefined ? num(m[4], yInt, yDec) : 0;
        arcExtremes(x, y, nx, ny, i, j, mode === "cw", multi, add);
      }
    } else if (op === "3") {
      add(nx, ny); // a flash on the outline layer is still geometry
    }
    x = nx;
    y = ny;
  }
  if (!Number.isFinite(box.minX)) throw new GerberError("gerber_outline_empty");
  if (!unit) throw new GerberError("gerber_no_units");
  const k = unit === "in" ? 25.4 : 1;
  return { minX: box.minX * k, minY: box.minY * k, maxX: box.maxX * k, maxY: box.maxY * k };
}

/** Add the arc's axis-crossing points (0°, 90°, 180°, 270°) that lie on the swept arc. */
function arcExtremes(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  i: number,
  j: number,
  cw: boolean,
  multi: boolean,
  add: (x: number, y: number) => void,
): void {
  let cx: number, cy: number;
  if (multi) {
    cx = sx + i;
    cy = sy + j;
  } else {
    // Single-quadrant: I/J are unsigned; pick the sign combination whose radius fits the end point.
    let best = { cx: sx + i, cy: sy + j, err: Infinity };
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = { x: sx + a * Math.abs(i), y: sy + b * Math.abs(j) };
      const err = Math.abs(Math.hypot(ex - c.x, ey - c.y) - Math.hypot(sx - c.x, sy - c.y));
      if (err < best.err) best = { cx: c.x, cy: c.y, err };
    }
    cx = best.cx;
    cy = best.cy;
  }
  const r = Math.hypot(sx - cx, sy - cy);
  if (r === 0) return;
  const tau = 2 * Math.PI;
  const norm = (a: number) => ((a % tau) + tau) % tau;
  const a0 = norm(Math.atan2(sy - cy, sx - cx));
  const a1 = norm(Math.atan2(ey - cy, ex - cx));
  // Counter-clockwise sweep from a0 to a1 (a full circle when start == end in multi-quadrant mode).
  let sweep = cw ? norm(a0 - a1) : norm(a1 - a0);
  if (sweep === 0 && multi) sweep = tau;
  for (let q = 0; q < 4; q++) {
    const ang = q * Math.PI / 2;
    const d = cw ? norm(a0 - ang) : norm(ang - a0);
    if (d <= sweep + 1e-12) add(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
  }
}

export interface BoardSize {
  outlineFile: string;
  widthMm: number;
  heightMm: number;
  widthIn: number;
  heightIn: number;
  /** W × H in square inches (the number OSH Park bills). */
  areaSqIn: number;
}

/** 1 inch = 25.4 mm exactly. Values are rounded to 0.001 mm before converting. */
export function boardSizeFromBbox(outlineFile: string, b: Bbox): BoardSize {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const widthMm = r3(b.maxX - b.minX);
  const heightMm = r3(b.maxY - b.minY);
  if (!(widthMm > 0 && heightMm > 0)) throw new GerberError("gerber_outline_degenerate");
  const widthIn = widthMm / 25.4;
  const heightIn = heightMm / 25.4;
  return { outlineFile, widthMm, heightMm, widthIn, heightIn, areaSqIn: widthIn * heightIn };
}

/** Gerber zip → board outline bounding box. */
export async function boardSizeFromZip(zip: Uint8Array): Promise<BoardSize> {
  const outline = findOutline(await readZip(zip));
  return boardSizeFromBbox(outline.name, gerberBboxMm(outline.text));
}
