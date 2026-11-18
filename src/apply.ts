/**
 * apply — replace the drawing inside a report PDF with the same drawing taken from the
 * source SVG, emitted as vector (tiling patterns for the fills, real text for the labels).
 *
 * This is the end-to-end tool: report.pdf + drawing.svg → report with a vector column.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import { parseItems, itemOps, circleOps, hexColor, type Mat } from './svgitems.js';
import { loadSvg, type SvgPattern } from './svg.js';
import { pathToPdf, type PathOp } from './svgpath.js';
import { collectPaints } from './paints.js';
import { IDENTITY } from './content.js';
import { dictName, dictNumber, resolve, streamBytes } from './images.js';

export interface ApplyReport {
  file: string;
  output: string;
  from: [number, number, number, number];
  to: [number, number, number, number];
  scale: [number, number];
  shapes: number;
  patterns: number;
  texts: number;
  imagesBefore: number;
  imagesAfter: number;
  sizeBefore: number;
  sizeAfter: number;
  warnings: string[];
}

export interface ApplyOptions {
  input: string;
  svg: string;
  output?: string;
  rect?: [number, number, number, number];
  cover?: [number, number, number, number];
  dryRun?: boolean;
}

const fmt = (v: number): string => {
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

const isStream = (o: unknown): o is PDFRawStream => o instanceof PDFRawStream;

interface TextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  color: [number, number, number];
  anchor: string;
}

/** collect <text>/<tspan> runs with their transforms applied */
export function parseTextRuns(svgText: string): TextRun[] {
  const runs: TextRun[] = [];
  const parseAttrs = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(s))) out[a[1]] = a[2];
    return out;
  };
  const mul = (p: Mat, c: Mat): Mat => ({
    a: p.a * c.a + p.c * c.b,
    b: p.b * c.a + p.d * c.b,
    c: p.a * c.c + p.c * c.d,
    d: p.b * c.c + p.d * c.d,
    e: p.a * c.e + p.c * c.f + p.e,
    f: p.b * c.e + p.d * c.f + p.f,
  });
  const parseTransform = (v: string | undefined): Mat => {
    if (!v) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    let out: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const rr = /(matrix|translate|scale)\s*\(([^)]*)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = rr.exec(v))) {
      const n = mm[2].split(/[\s,]+/).filter(Boolean).map(Number);
      if (mm[1] === 'matrix' && n.length >= 6)
        out = mul(out, { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] });
      else if (mm[1] === 'translate')
        out = mul(out, { a: 1, b: 0, c: 0, d: 1, e: n[0] ?? 0, f: n[1] ?? 0 });
      else if (mm[1] === 'scale')
        out = mul(out, { a: n[0] ?? 1, b: 0, c: 0, d: n[1] ?? n[0] ?? 1, e: 0, f: 0 });
    }
    return out;
  };

  const gStack: Mat[] = [{ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }];
  const styleStack: Record<string, string>[] = [{}];
  const INHERIT = ['fill', 'font-size', 'font-weight', 'text-anchor'];
  let textCtx: { m: Mat; attrs: Record<string, string>; inTspan: boolean } | undefined;
  let tspanPos: { x: number; y: number } = { x: 0, y: 0 };

  const re = /<(\/?)(svg|g|defs|text|tspan)\b([^>]*?)(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  let defs = 0;
  while ((m = re.exec(svgText))) {
    if (m[5] !== undefined) {
      // character data inside a <tspan>
      const raw = m[5];
      if (textCtx && textCtx.inTspan && raw.trim()) {
        const text = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const a = textCtx.attrs;
        runs.push({
          text,
          x: (Number(a.x ?? 0) || 0) + tspanPos.x,
          y: (Number(a.y ?? 0) || 0) + tspanPos.y,
          size: Number(a['font-size'] ?? 12) || 12,
          bold: Number(a['font-weight'] ?? 400) >= 600,
          color: hexColor(a.fill) ?? [0, 0, 0],
          anchor: a['text-anchor'] ?? 'start',
        });
        // the run's transform is the <text> transform on top of the <g> chain
        (runs[runs.length - 1] as TextRun & { m?: Mat }).m = textCtx.m;
      }
      continue;
    }
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const selfClose = !!m[4];
    if (tag === 'defs') {
      if (closing) defs = Math.max(0, defs - 1);
      else if (!selfClose) defs++;
      continue;
    }
    const attrs = parseAttrs(m[3]);
    if (tag === 'g' || tag === 'svg') {
      if (closing) {
        if (gStack.length > 1) {
          gStack.pop();
          styleStack.pop();
        }
        continue;
      }
      const own = mul(gStack[gStack.length - 1], parseTransform(attrs.transform));
      const parent = styleStack[styleStack.length - 1];
      const eff: Record<string, string> = {};
      for (const k of INHERIT) {
        const raw = attrs[k];
        const v = raw === undefined || raw === 'inherit' ? parent[k] : raw;
        if (v !== undefined) eff[k] = v;
      }
      if (!selfClose && defs === 0) {
        gStack.push(own);
        styleStack.push(eff);
      } else if (!selfClose) {
        gStack.push(own);
        styleStack.push(eff);
      }
      continue;
    }
    if (tag === 'text') {
      if (closing) {
        textCtx = undefined;
        continue;
      }
      const parent = styleStack[styleStack.length - 1];
      const eff: Record<string, string> = {};
      for (const k of INHERIT) {
        const raw = attrs[k];
        const v = raw === undefined || raw === 'inherit' ? parent[k] : raw;
        if (v !== undefined) eff[k] = v;
      }
      textCtx = {
        m: mul(gStack[gStack.length - 1], parseTransform(attrs.transform)),
        attrs: { ...eff, ...attrs },
        inTspan: false,
      };
      continue;
    }
    if (tag === 'tspan') {
      if (closing) {
        if (textCtx) textCtx.inTspan = false;
        continue;
      }
      if (textCtx) {
        textCtx.inTspan = true;
        tspanPos = {
          x: Number(attrs.x ?? 0) || 0,
          y: (Number(attrs.y ?? 0) || 0) + (Number(attrs.dy ?? 0) || 0),
        };
        if (selfClose) textCtx.inTspan = false;
      }
      continue;
    }
  }
  return runs;
}
export async function applyPdf(options: ApplyOptions): Promise<ApplyReport> {
  const inputBytes = readFileSync(options.input);
  const doc = await PDFDocument.load(inputBytes, { updateMetadata: false, ignoreEncryption: true });
  const ctx = doc.context as any;
  const page = doc.getPages()[0];
  const pageW = page.getWidth();
  const pageH = page.getHeight();
  const warnings: string[] = [];

  // ---- reference frame ----------------------------------------------------
  const pageRes = page.node.Resources() as PDFDict | undefined;
  const pageXObjects = pageRes ? resolve<PDFDict>(ctx, pageRes.lookup(PDFName.of('XObject'))) : undefined;
  const contentsObj = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contentsObj instanceof PDFRawStream) streams.push(contentsObj);
  else if (contentsObj instanceof PDFArray) {
    for (let i = 0; i < contentsObj.size(); i++) {
      const s = resolve<PDFRawStream>(ctx, contentsObj.get(i));
      if (s) streams.push(s);
    }
  }
  const oldContent = Buffer.concat(streams.map((s) => streamBytes(s, ctx)));
  const formLookup = (name: string, ctm: typeof IDENTITY) => {
    const f = pageXObjects ? resolve<PDFRawStream>(ctx, pageXObjects.lookup(PDFName.of(name))) : undefined;
    if (!f || !isStream(f) || dictName(f.dict, 'Subtype') !== 'Form') return undefined;
    try {
      return { content: streamBytes(f, ctx), ctm };
    } catch {
      return undefined;
    }
  };
  const paints = collectPaints(oldContent, IDENTITY, formLookup);
  const narrow = paints.filter((p) => {
    const w = p.bbox[2] - p.bbox[0];
    const h = p.bbox[3] - p.bbox[1];
    return p.pattern && h > w * 3;
  });
  if (!narrow.length) throw new Error('apply: could not find the hatched fills in the report');
  const band: [number, number, number, number] = [
    Math.min(...narrow.map((p) => p.bbox[0])),
    Math.min(...narrow.map((p) => p.bbox[1])),
    Math.max(...narrow.map((p) => p.bbox[2])),
    Math.max(...narrow.map((p) => p.bbox[3])),
  ];

  const svg = loadSvg(options.svg);
  const svgText = readFileSync(options.svg, 'utf8');
  const items = parseItems(svgText);
  const byId = new Map(svg.patterns.map((c) => [c.id, c]));

  // the SVG's own hatched fills are the anchor: same feature, same place
  const svgWalls: { bbox: [number, number, number, number]; cell: string }[] = [];
  for (const it of items) {
    const fill = it.attrs.fill ?? '';
    if (!fill.startsWith('url(')) continue;
    const cell = byId.get(fill.slice(5, fill.lastIndexOf(')')));
    if (!cell || cell.lines.length < 2) continue;
    const bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const op of itemOps(it)) {
      for (let i = 1; i + 1 < op.length; i += 2) {
        const x = it.m.a * (op[i] as number) + it.m.c * (op[i + 1] as number) + it.m.e;
        const y = it.m.b * (op[i] as number) + it.m.d * (op[i + 1] as number) + it.m.f;
        if (x < bb[0]) bb[0] = x;
        if (y < bb[1]) bb[1] = y;
        if (x > bb[2]) bb[2] = x;
        if (y > bb[3]) bb[3] = y;
      }
    }
    if (Number.isFinite(bb[0])) svgWalls.push({ bbox: bb, cell: cell.id });
  }
  if (!svgWalls.length) throw new Error('apply: the SVG has no hatched fills to align to');

  // Fit the affine on the individual walls rather than on their union: a casing that is
  // cut off at the page edge would otherwise skew the scale.
  const sortWalls = <T extends { bbox: [number, number, number, number] }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
  const pdfWalls = sortWalls(narrow.map((p) => ({ bbox: p.bbox })));
  const svgSorted = sortWalls(svgWalls);
  const pairs = Math.min(pdfWalls.length, svgSorted.length);
  let sx: number;
  let sy: number;
  let tx: number;
  let ty: number;
  if (options.rect) {
    const vb = svg.viewBox ?? [0, 0, 265, 1716];
    const [rx0, ry0, rx1, ry1] = options.rect;
    sx = (rx1 - rx0) / Math.max(vb[2], 1e-6);
    sy = (ry1 - ry0) / Math.max(vb[3], 1e-6);
    tx = rx0 - sx * vb[0];
    ty = ry1 + sy * vb[1];
    warnings.push('using --rect');
  } else if (pairs >= 3) {
    // least squares on the wall centres: pdf = s*svg + t, fitted separately per axis
    const fitAxis = (pick: (b: [number, number, number, number]) => number): { s: number; t: number } => {
      const xs = svgSorted.slice(0, pairs).map((w) => pick(w.bbox));
      const ys = pdfWalls.slice(0, pairs).map((w) => pick(w.bbox));
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) * (xs[i] - mx);
      }
      const s = den > 1e-9 ? num / den : 1;
      return { s, t: my - s * mx };
    };
    const fx = fitAxis((b) => (b[0] + b[2]) / 2);
    const fy = fitAxis((b) => (b[1] + b[3]) / 2);
    sx = Number.isFinite(fx.s) && fx.s > 0 ? fx.s : 1;
    sy = Number.isFinite(fy.s) && fy.s > 0 ? -fy.s : 1;
    tx = fx.t;
    ty = -fy.t;
    warnings.push(`fitted ${pairs} casing fills: sx ${sx.toFixed(4)} sy ${Math.abs(sy).toFixed(4)}`);
  } else {
    const svgBand: [number, number, number, number] = [
      Math.min(...svgWalls.map((w) => w.bbox[0])),
      Math.min(...svgWalls.map((w) => w.bbox[1])),
      Math.max(...svgWalls.map((w) => w.bbox[2])),
      Math.max(...svgWalls.map((w) => w.bbox[3])),
    ];
    sx = (band[2] - band[0]) / Math.max(svgBand[2] - svgBand[0], 1e-6);
    sy = (band[3] - band[1]) / Math.max(svgBand[3] - svgBand[1], 1e-6);
    tx = band[0] - sx * svgBand[0];
    ty = band[3] + sy * svgBand[1];
  }

  const place = (m: Mat, x: number, y: number): [number, number] => {
    const px = m.a * x + m.c * y + m.e;
    const py = m.b * x + m.d * y + m.f;
    return [tx + sx * px, ty - sy * py];
  };

  // ---- patterns -----------------------------------------------------------
  let patternRes = pageRes ? resolve<PDFDict>(ctx, pageRes.lookup(PDFName.of('Pattern'))) : undefined;
  if (!pageRes) throw new Error('apply: page has no resources');
  if (!(patternRes instanceof PDFDict)) {
    patternRes = ctx.obj({}) as PDFDict;
    pageRes.set(PDFName.of('Pattern'), patternRes);
  }
  const registered = new Map<string, string>();
  const SEAM = 0.1;
  let patterns = 0;

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
      // content is authored y-down in page units, so only a flip is needed here
      Matrix: [1, 0, 0, -1, 0, H],
      Filter: 'FlateDecode',
      Length: packed.length,
    }) as PDFDict;
    const ref = ctx.nextRef();
    ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(packed)));
    const name = `WP${++patterns}`;
    patternRes!.set(PDFName.of(name), ref);
    registered.set(key, name);
    return name;
  };

  const registerTexture = (cell: SvgPattern): string => {
    const hit = registered.get(cell.id);
    if (hit) return hit;
    const body: string[] = [];
    const v = cell.viewBox;
    const ux = v && v[2] ? cell.width / v[2] : 1;
    const uy = v && v[3] ? cell.height / v[3] : 1;
    const toCell = (x: number, y: number): [number, number] => [
      (v ? x - v[0] : x) * ux * sx,
      (v ? y - v[1] : y) * uy * sy,
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
    }
    return emit(cell.id, cell.width * sx, cell.height * sy, body);
  };

  const registerHatch = (cell: SvgPattern): string => {
    const key = `hatch:${cell.id}`;
    const hit = registered.get(key);
    if (hit) return hit;
    const l0 = cell.lines[0];
    // direction and spacing of the family, in page units (y down, as the tile is)
    const dx = (l0.x2 - l0.x1) * sx;
    const dy = (l0.y2 - l0.y1) * sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const offs = cell.lines
      .map((l) => nx * l.x1 * sx + ny * l.y1 * sy)
      .sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < offs.length; i++) {
      const g = offs[i] - offs[i - 1];
      if (g > 1e-6) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const spacing = gaps.length ? gaps[(gaps.length / 2) | 0] : 5 * sy;
    const A = spacing / Math.max(Math.abs(nx), 1e-6);
    const B = spacing / Math.max(Math.abs(ny), 1e-6);
    const mult = 5;
    const W = A * mult;
    const H = B * mult;
    const L = Math.hypot(W, H) * 1.2;
    const body: string[] = [
      `0 g 0 G ${fmt(Math.max(l0.strokeWidth, 0.05) * Math.abs(sy))} w 0 J 0 j`,
    ];
    for (let i = 0; i < mult; i++) {
      for (let j = 0; j < mult; j++) {
        const cx = i * A;
        const cy = j * B;
        body.push(`${fmt(cx - ux * L)} ${fmt(cy - uy * L)} m ${fmt(cx + ux * L)} ${fmt(cy + uy * L)} l S`);
      }
    }
    if (process.env.STAMP_DEBUG) {
      console.log('hatch', cell.id.slice(0, 28), 'spacing', spacing.toFixed(3), 'tile', W.toFixed(1), H.toFixed(1));
    }
    return emit(key, W, H, body);
  };

  // ---- drawing ------------------------------------------------------------
  const body: string[] = [];
  let shapes = 0;
  for (const item of items) {
    const ops = itemOps(item);
    if (!ops.length) continue;
    const code = pathToPdf(ops, (x, y) => place(item.m, x, y), fmt);
    const fillAttr = item.attrs.fill ?? 'inherit';
    const strokeAttr = item.attrs.stroke ?? '';
    const sw = Number(item.attrs['stroke-width'] ?? 0);
    let patternName: string | undefined;
    let fillCol: [number, number, number] | undefined;
    if (fillAttr.startsWith('url(')) {
      const cell = byId.get(fillAttr.slice(5, fillAttr.lastIndexOf(')')));
      if (cell) patternName = cell.lines.length >= 2 ? registerHatch(cell) : registerTexture(cell);
    } else if (fillAttr !== 'none' && fillAttr !== 'inherit') {
      fillCol = hexColor(fillAttr) ?? undefined;
    }
    const strokeCol = strokeAttr && strokeAttr !== 'none' ? hexColor(strokeAttr) : undefined;
    if (patternName) {
      body.push('/Pattern cs', `/${patternName} scn`, ...code, 'f');
    } else if (fillCol) {
      body.push(`${fmt(fillCol[0])} ${fmt(fillCol[1])} ${fmt(fillCol[2])} rg`, ...code, 'f');
    }
    if (strokeCol && sw > 0) {
      body.push(
        `${fmt(strokeCol[0])} ${fmt(strokeCol[1])} ${fmt(strokeCol[2])} RG ${fmt(sw * sy)} w 0 J 0 j`,
        ...code,
        'S',
      );
    }
    shapes++;
  }

  // ---- text (pdf-lib writes its own stream, we put ours underneath) --------
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  // the report already carries these labels; redrawing them would duplicate them
  const runs = parseTextRuns(svgText);
  if (process.env.STAMP_DEBUG) console.log('text runs found:', runs.length, 'svg chars', svgText.length);
  let texts = 0;
  for (const run of runs) {
    const runMat = (run as TextRun & { m?: Mat }).m ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const p = place(runMat, run.x, run.y);
    const size = run.size * Math.abs(sy);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const font = run.bold ? helvBold : helv;
    const w = font.widthOfTextAtSize(run.text, size);
    const x = run.anchor === 'middle' ? p[0] - w / 2 : run.anchor === 'end' ? p[0] - w : p[0];
    const hex = font.encodeText(run.text).toString();
    body.push(
      'BT',
      `/${run.bold ? 'FT2' : 'FT1'} ${fmt(size)} Tf`,
      `${fmt(run.color[0])} ${fmt(run.color[1])} ${fmt(run.color[2])} rg`,
      `1 0 0 1 ${fmt(x)} ${fmt(p[1] - size * 0.8)} Tm`,
      `${hex} Tj`,
      'ET',
    );
    texts++;
  }
  // fonts have to be reachable from the page for those Tf operators
  let fontRes = resolve<PDFDict>(ctx, pageRes.lookup(PDFName.of('Font')));
  if (!(fontRes instanceof PDFDict)) {
    fontRes = ctx.obj({}) as PDFDict;
    pageRes.set(PDFName.of('Font'), fontRes);
  }
  fontRes.set(PDFName.of('FT1'), helv.ref);
  fontRes.set(PDFName.of('FT2'), helvBold.ref);

  // ---- compose: old content (in q/Q) + white cover + our drawing -----------
  const cover: [number, number, number, number] = options.cover
    ? [options.cover[0], options.cover[1], options.cover[2], options.cover[3]]
    : options.rect
    ? [options.rect[0], options.rect[1], options.rect[2], options.rect[3]]
    : [
        Math.max(0, tx),
        Math.max(0, ty - sy * (svg.viewBox?.[3] ?? 0)),
        Math.min(pageW, tx + sx * (svg.viewBox?.[2] ?? 0)),
        Math.min(pageH, ty),
      ];
  const white = `q 1 1 1 rg ${fmt(cover[0])} ${fmt(cover[1])} ${fmt(cover[2] - cover[0])} ${fmt(
    cover[3] - cover[1],
  )} re f Q`;
  const added = `q\n${oldContent.toString('latin1')}\nQ\n${white}\nq\n${body.join('\n')}\nQ\n`;
  const packed = deflateSync(Buffer.from(added, 'latin1'));
  const cdict = ctx.obj({ Filter: 'FlateDecode', Length: packed.length }) as PDFDict;
  const cref = ctx.nextRef();
  ctx.assign(cref, PDFRawStream.of(cdict, new Uint8Array(packed)));

  page.node.set(PDFName.of('Contents'), cref);

  // ---- drop the old raster patterns (their images are the 4.5 MB) ----------
  const dropImages = new Set<number>();
  for (const [pref, obj] of ctx.enumerateIndirectObjects() as [PDFRef, unknown][]) {
    if (!isStream(obj)) continue;
    if (!(dictName(obj.dict, 'Type') === 'Pattern' && dictNumber(obj.dict, 'PatternType') === 1)) continue;
    const res = resolve<PDFDict>(ctx, obj.dict.lookup(PDFName.of('Resources')));
    const xo = res ? resolve<PDFDict>(ctx, res.lookup(PDFName.of('XObject'))) : undefined;
    if (!xo || !xo.keys().length) continue;
    for (const k of xo.keys()) {
      const r = xo.get(k);
      if (r instanceof PDFRef) dropImages.add(r.objectNumber);
      const img = resolve<PDFRawStream>(ctx, r);
      if (img && isStream(img)) {
        const mask = img.dict.get(PDFName.of('SMask'));
        if (mask instanceof PDFRef) dropImages.add(mask.objectNumber);
      }
    }
    const empty = deflateSync(Buffer.from('q Q\n', 'latin1'));
    obj.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    obj.dict.set(PDFName.of('Length'), PDFNumber.of(empty.length));
    ctx.assign(pref, PDFRawStream.of(obj.dict, new Uint8Array(empty)));
    res!.delete(PDFName.of('XObject'));
  }
  const report: ApplyReport = {
    file: options.input,
    output: options.output ?? options.input.replace(/\.pdf$/i, ' vector.pdf'),
    from: [band[0], band[1], band[2], band[3]],
    to: [cover[0], cover[1], cover[2], cover[3]],
    scale: [Number(sx.toFixed(4)), Number(sy.toFixed(4))],
    shapes,
    patterns,
    texts,
    imagesBefore: 0,
    imagesAfter: 0,
    sizeBefore: inputBytes.length,
    sizeAfter: 0,
    warnings,
  };
  const before = (ctx.enumerateIndirectObjects() as [PDFRef, unknown][]).filter(
    ([, o]) => isStream(o) && dictName(o.dict, 'Subtype') === 'Image',
  ).length;
  report.imagesBefore = before;

  if (options.dryRun) return report;

  for (const [ref, obj] of ctx.enumerateIndirectObjects() as [PDFRef, unknown][]) {
    if (!isStream(obj) || dictName(obj.dict, 'Subtype') !== 'Image') continue;
    if (!dropImages.has(ref.objectNumber)) continue;
    try {
      ctx.delete(ref);
    } catch {
      /* ignore */
    }
  }
  const bytes = await doc.save({ useObjectStreams: true });
  writeFileSync(report.output, bytes);
  report.sizeAfter = bytes.length;
  const check = await PDFDocument.load(readFileSync(report.output), { ignoreEncryption: true });
  report.imagesAfter = ((check.context as any).enumerateIndirectObjects() as [PDFRef, unknown][]).filter(
    ([, o]) => isStream(o) && dictName(o.dict, 'Subtype') === 'Image',
  ).length;
  void PDFNumber;
  return report;
}
