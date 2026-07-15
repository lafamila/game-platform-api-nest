// Pure, dependency-free helpers for the 기보(gibo) PDF export — captions, filename, grid
// pagination, and a minimal JPEG-embedding PDF encoder. This is the tested reference
// implementation; the /replay page (replay-view.page.ts) inlines a byte-for-byte browser
// port of encodeJpegPdf + giboGridPlan + the caption helpers (no build pipeline for that
// static page, so the copy is deliberate — KEEP THE TWO IN SYNC). All logic here is
// renderer-independent: the browser rasterizes boards to JPEG via the shared canvas painter,
// then feeds the bytes + placements into the same encoder shape tested here.

export function giboFileName(gameKey: string, sessionId: string): string {
  return `gibo-${gameKey}-${sessionId}.pdf`;
}

export function giboColorLabel(color: string): string {
  return color === 'black' ? '흑' : '백';
}

export interface GiboMoveLike {
  type: 'move' | 'pass';
  color: string;
  x?: number;
  y?: number;
}

// Per-tile caption, e.g. "12수 · 흑 (8,8)" or "13수 · 백 패스" (1-based move number and coords).
export function giboMoveCaption(index: number, move: GiboMoveLike): string {
  const n = index + 1;
  const who = giboColorLabel(move.color);
  if (move.type === 'pass') {
    return `${n}수 · ${who} 패스`;
  }
  const x = typeof move.x === 'number' ? move.x + 1 : '?';
  const y = typeof move.y === 'number' ? move.y + 1 : '?';
  return `${n}수 · ${who} (${x},${y})`;
}

// Page count when page 1 holds cap1 tiles (header steals room) and the rest hold capRest.
export function giboPageCount(tileCount: number, cap1: number, capRest: number): number {
  if (tileCount <= 0) return 1;
  if (tileCount <= cap1) return 1;
  return 1 + Math.ceil((tileCount - cap1) / Math.max(1, capRest));
}

export interface GiboGridOptions {
  pageW: number;
  pageH: number;
  margin: number;
  cols: number;
  colGap: number;
  rowGap: number;
  headerHpt: number; // header band height on page 1 (0 = no header)
  tileAspect: number; // tileH / tileW
}

export interface GiboSlot {
  page: number;
  xPt: number;
  yTopPt: number; // top-based; convert to PDF bottom-left at encode time
}

export interface GiboGridPlan {
  tileW: number;
  tileH: number;
  cap1: number;
  capRest: number;
  pages: number;
  slots: GiboSlot[];
}

// Lays tiles into a cols-wide grid, top-to-bottom, page 1 offset below the header band.
export function giboGridPlan(tileCount: number, opts: GiboGridOptions): GiboGridPlan {
  const contentW = opts.pageW - 2 * opts.margin;
  const tileW = (contentW - (opts.cols - 1) * opts.colGap) / opts.cols;
  const tileH = tileW * opts.tileAspect;
  const gridTop1 = opts.margin + (opts.headerHpt > 0 ? opts.headerHpt + opts.rowGap : 0);
  const rowsFor = (top: number) =>
    Math.max(1, Math.floor((opts.pageH - top - opts.margin + opts.rowGap) / (tileH + opts.rowGap)));
  const rowsFirst = rowsFor(gridTop1);
  const rowsRest = rowsFor(opts.margin);
  const cap1 = rowsFirst * opts.cols;
  const capRest = rowsRest * opts.cols;
  const slots: GiboSlot[] = [];
  let i = 0;
  for (let page = 0; i < tileCount; page += 1) {
    const cap = page === 0 ? cap1 : capRest;
    const gridTop = page === 0 ? gridTop1 : opts.margin;
    for (let k = 0; k < cap && i < tileCount; k += 1, i += 1) {
      const row = Math.floor(k / opts.cols);
      const col = k % opts.cols;
      slots.push({
        page,
        xPt: opts.margin + col * (tileW + opts.colGap),
        yTopPt: gridTop + row * (tileH + opts.rowGap),
      });
    }
  }
  return { tileW, tileH, cap1, capRest, pages: giboPageCount(tileCount, cap1, capRest), slots };
}

export interface GiboPlacement {
  jpeg: Uint8Array;
  wPx: number;
  hPx: number;
  xPt: number;
  yPtBottom: number; // PDF space (origin bottom-left)
  wPt: number;
  hPt: number;
}

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function pad10(n: number): string {
  return String(n).padStart(10, '0');
}

/**
 * Assembles a PDF whose every page places JPEG image XObjects (DCTDecode) — no fonts, so any
 * text (Korean headers/captions) must already be rastered into the images. `pages[p]` is the
 * list of placements on page p (PDF bottom-left coords). Returns the complete PDF bytes.
 */
export function encodeJpegPdf(pageWpt: number, pageHpt: number, pages: GiboPlacement[][]): Uint8Array {
  const objs: Uint8Array[] = []; // objs[num-1] = inner body bytes
  const put = (n: number, body: Uint8Array) => {
    objs[n - 1] = body;
  };
  let next = 3; // 1 = Catalog, 2 = Pages
  const pageRefs: number[] = [];
  for (const placements of pages) {
    const imgNums: number[] = [];
    let content = '';
    for (const pl of placements) {
      const inum = next++;
      const dict =
        `<< /Type /XObject /Subtype /Image /Width ${pl.wPx} /Height ${pl.hPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pl.jpeg.length} >>\nstream\n`;
      put(inum, concat([enc(dict), pl.jpeg, enc('\nendstream')]));
      imgNums.push(inum);
      content += `q ${num(pl.wPt)} 0 0 ${num(pl.hPt)} ${num(pl.xPt)} ${num(pl.yPtBottom)} cm /Im${inum} Do Q\n`;
    }
    const cnum = next++;
    const cbytes = enc(content);
    put(cnum, concat([enc(`<< /Length ${cbytes.length} >>\nstream\n`), cbytes, enc('\nendstream')]));
    const pnum = next++;
    const res = imgNums.map((n) => `/Im${n} ${n} 0 R`).join(' ');
    put(
      pnum,
      enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWpt)} ${num(pageHpt)}] ` +
          `/Resources << /XObject << ${res} >> >> /Contents ${cnum} 0 R >>`,
      ),
    );
    pageRefs.push(pnum);
  }
  put(2, enc(`<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`));
  put(1, enc('<< /Type /Catalog /Pages 2 0 R >>'));

  let out = concat([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a])]); // %PDF-1.4 + binary marker
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i += 1) {
    const n = i + 1;
    offsets[n] = out.length;
    out = concat([out, enc(`${n} 0 obj\n`), objs[i] ?? enc('<< >>'), enc('\nendobj\n')]);
  }
  const xrefStart = out.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objs.length; n += 1) {
    xref += `${pad10(offsets[n] ?? 0)} 00000 n \n`;
  }
  out = concat([
    out,
    enc(xref),
    enc(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`),
  ]);
  return out;
}
