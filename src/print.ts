/**
 * print — draw an SVG straight into a PDF page at 1:1 (no fitting, no archaeology).
 *
 * This is the reference implementation of "svg → pdf" for our drawings: the page is the
 * SVG's viewBox, one SVG unit is one point, and every paint server is emitted as a real
 * PDF construct (clipped line families for hatches, tiling patterns for dot textures).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { parseItems, itemOps, circleOps, hexColor, type Mat } from './svgitems.js';
import { loadSvg, type SvgPattern } from './svg.js';
import { pathToPdf, type PathOp } from './svgpath.js';

export interface PrintReport {
  svg: string;
  output: string;
  page: [number, number];
  shapes: number;
  patterns: number;
  size: number;
}

const fmt = (v: number): string => {
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

export async function printSvg(svgPath: string, output: string): Promise<PrintReport> {
  const svg = loadSvg(svgPath);
  const text = readFileSync(svgPath, 'utf8');
  const items = parseItems(text);
  const vb = svg.viewBox ?? [0, 0, 265, 1716];
  const width = vb[2];
  const height = vb[3];

  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const ctx = doc.context as any;
  const pageRes = ctx.obj({}) as PDFDict;
  page.node.set(PDFName.of('Resources'), pageRes);
  const patternRes = ctx.obj({}) as PDFDict;
  pageRes.set(PDFName.of('Pattern'), patternRes);

  // SVG y grows downward, PDF y grows upward
  const place = (m: Mat, x: number, y: number): [number, number] => {
    const px = m.a * x + m.c * y + m.e;
    const py = m.b * x + m.d * y + m.f;
    return [px, height - py];
  };

  const byId = new Map(svg.patterns.map((c) => [c.id, c]));
  const registered = new Map<string, string>();

  /** XStep/YStep are 0.1 smaller than the BBox: tiles overlap, so no seams appear. */
  const SEAM = 0.1;

  const emit = (key: string, W: number, H: number, body: string[]): string => {
    const packed = deflateSync(Buffer.from(body.join('\n') + '\n', 'latin1'));
    const dict = ctx.obj({
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, W, H],
      XStep: W - SEAM,
      YStep: H - SEAM,
      Matrix: [1, 0, 0, -1, 0, H],
      Filter: 'FlateDecode',
      Length: packed.length,
    }) as PDFDict;
    const ref = ctx.nextRef();
    ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(packed)));
    const name = `SP${registered.size + 1}`;
    patternRes.set(PDFName.of(name), ref);
    registered.set(key, name);
    return name;
  };

  /** dot texture: the tile is exactly one cell, content copied verbatim */
  const registerTexture = (cell: SvgPattern): string => {
    const hit = registered.get(cell.id);
    if (hit) return hit;
    const cw = cell.width;
    const ch = cell.height;
    const body: string[] = [];
    const v = cell.viewBox;
    const ux = v && v[2] ? cell.width / v[2] : 1;
    const uy = v && v[3] ? cell.height / v[3] : 1;
    const toCell = (x: number, y: number): [number, number] => [
      (v ? x - v[0] : x) * ux,
      (v ? y - v[1] : y) * uy,
    ];
    for (const shape of cell.shapes) {
      const fill = hexColor(shape.fill) ?? hexColor(cell.fill);
      const stroke = hexColor(shape.stroke);
      const ops: PathOp[] =
        shape.kind === 'path'
          ? shape.ops ?? []
          : shape.kind === 'rect' && shape.rect
            ? ([
                ['m', shape.rect[0], shape.rect[1]],
                ['l', shape.rect[0] + shape.rect[2], shape.rect[1]],
                ['l', shape.rect[0] + shape.rect[2], shape.rect[1] + shape.rect[3]],
                ['l', shape.rect[0], shape.rect[1] + shape.rect[3]],
                ['z'],
              ] as PathOp[])
            : shape.kind === 'circle' && shape.circle
              ? circleOps(shape.circle[0], shape.circle[1], shape.circle[2])
              : [];
      if (!ops.length) continue;
      const code = pathToPdf(ops, toCell, fmt);
      const col = fill ?? [0, 0, 0];
      body.push(`${fmt(col[0])} ${fmt(col[1])} ${fmt(col[2])} rg`, ...code, 'f');
      if (stroke && shape.strokeWidth) {
        body.push(
          `${fmt(stroke[0])} ${fmt(stroke[1])} ${fmt(stroke[2])} RG ${fmt(shape.strokeWidth)} w`,
          ...code,
          'S',
        );
      }
    }
    return emit(cell.id, cw, ch, body);
  };

  /**
   * Line hatch: the tile spans several lattice periods and contains one line per
   * lattice cell, each drawn long enough to cross the whole tile. Nothing is then
   * lost to the tile clip, which is what makes a one-cell tile look half empty.
   */
  const registerHatch = (cell: SvgPattern): string => {
    const key = `hatch:${cell.id}`;
    const hit = registered.get(key);
    if (hit) return hit;
    const l0 = cell.lines[0];
    const dx = l0.x2 - l0.x1;
    const dy = l0.y2 - l0.y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const offs = cell.lines.map((l) => nx * l.x1 + ny * l.y1).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < offs.length; i++) {
      const g = offs[i] - offs[i - 1];
      if (g > 1e-6) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const spacing = gaps.length ? gaps[(gaps.length / 2) | 0] : 5;
    // one period of the family along x and along y
    const A = spacing / Math.max(Math.abs(nx), 1e-6);
    const B = spacing / Math.max(Math.abs(ny), 1e-6);
    const mult = 5;
    const W = A * mult;
    const H = B * mult;
    const L = Math.hypot(W, H) * 1.2;
    const body: string[] = [`0 g 0 G ${fmt(Math.max(l0.strokeWidth, 0.05))} w 0 J 0 j`];
    for (let i = 0; i < mult; i++) {
      for (let j = 0; j < mult; j++) {
        const cx = l0.x1 + i * A;
        const cy = l0.y1 + j * B;
        body.push(
          `${fmt(cx - ux * L)} ${fmt(cy - uy * L)} m ${fmt(cx + ux * L)} ${fmt(cy + uy * L)} l S`,
        );
      }
    }
    if (process.env.STAMP_DEBUG) {
      console.log('hatch pattern', cell.id, 'spacing', spacing.toFixed(3), 'tile', W.toFixed(2), H.toFixed(2), 'lines', mult * mult);
    }
    return emit(key, W, H, body);
  };

  const body: string[] = [];
  let shapes = 0;
  for (const item of items) {
    const a = item.attrs;
    const ops = itemOps(item);
    if (!ops.length) continue;
    const code = pathToPdf(ops, (x, y) => place(item.m, x, y), fmt);
    const fillAttr = a.fill ?? 'inherit';
    const strokeAttr = a.stroke ?? '';
    const sw = Number(a['stroke-width'] ?? 0);

    let patternName: string | undefined;
    let fillCol: [number, number, number] | undefined;
    let hatchCell: SvgPattern | undefined;
    if (fillAttr.startsWith('url(')) {
      const id = fillAttr.slice(5, fillAttr.lastIndexOf(')'));
      const cell = byId.get(id);
      if (cell) {
        patternName = cell.lines.length >= 2 ? registerHatch(cell) : registerTexture(cell);
      }
    } else if (fillAttr === 'none') {
      fillCol = undefined;
    } else if (fillAttr === 'inherit') {
      fillCol = undefined;
    } else {
      fillCol = hexColor(fillAttr) ?? [0, 0, 0];
    }
    const strokeCol = strokeAttr && strokeAttr !== 'none' ? hexColor(strokeAttr) : undefined;
    if (process.env.STAMP_DEBUG) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const op of ops) for (let i = 1; i + 1 < op.length; i += 2) { const p = place(item.m, op[i] as number, op[i + 1] as number); x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      if (x0 < 90 && x1 > 70 && y0 < 1140 && y1 > 1100) console.log('item', item.tag, 'fill', (fillAttr||'-').slice(0,32), 'sw', sw, 'sw2', strokeAttr.slice(0,8), 'bbox', [x0,y0,x1,y1].map(v=>v.toFixed(0)).join(','));
    }

    if (!patternName && !fillCol) {
      if (strokeCol && sw > 0) {
        body.push(`${fmt(strokeCol[0])} ${fmt(strokeCol[1])} ${fmt(strokeCol[2])} RG ${fmt(sw)} w 0 J 0 j`, ...code, 'S');
        shapes++;
      }
      continue;
    }
    if (patternName) {
      body.push('/Pattern cs', `/${patternName} scn`, ...code, 'f');
    } else if (fillCol) {
      body.push(`${fmt(fillCol[0])} ${fmt(fillCol[1])} ${fmt(fillCol[2])} rg`, ...code, 'f');
    }
    if (strokeCol && sw > 0) {
      body.push(`${fmt(strokeCol[0])} ${fmt(strokeCol[1])} ${fmt(strokeCol[2])} RG ${fmt(sw)} w 0 J 0 j`, ...code, 'S');
    }
    shapes++;
  }

  const content = deflateSync(Buffer.from(body.join('\n') + '\n', 'latin1'));
  const cdict = ctx.obj({ Filter: 'FlateDecode', Length: content.length }) as PDFDict;
  const cref = ctx.nextRef();
  ctx.assign(cref, PDFRawStream.of(cdict, new Uint8Array(content)));
  page.node.set(PDFName.of('Contents'), cref);
  void PDFArray;
  void PDFNumber;

  const bytes = await doc.save({ useObjectStreams: true });
  writeFileSync(output, bytes);
  return {
    svg: svgPath,
    output,
    page: [width, height],
    shapes,
    patterns: registered.size,
    size: bytes.length,
  };
}
