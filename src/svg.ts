/**
 * Reads the vector model out of the source SVG: its `<pattern>` definitions
 * (the hatch cells the raster strips were made from) plus a few sanity facts.
 *
 * The SVG is used as the design intent: the hatch angle and stroke width can be
 * snapped to it (`--from-svg`) so the rebuilt hatch follows the drawing, not the pixels.
 *
 * A tiny purpose-built scanner is enough here — we only need attributes of
 * <svg>, <pattern> and <line>, plus counts of <path>/<image>. That keeps the tool
 * dependency-free and tolerant of the machine-generated SVGs these reports use.
 */
import { readFileSync } from 'node:fs';
import { parsePath, type PathOp } from './svgpath.js';

export interface SvgLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

export interface CellShape {
  kind: 'path' | 'rect' | 'circle';
  ops?: PathOp[];
  rect?: [number, number, number, number];
  circle?: [number, number, number];
  fill?: string;
  stroke?: string;
  strokeWidth: number;
}

export interface SvgPattern {
  id: string;
  width: number;
  height: number;
  lines: SvgLine[];
  /** non-line children — stipple / dot / texture cells */
  shapes: CellShape[];
  viewBox?: [number, number, number, number];
  /** pattern-level paint, inherited by children without their own */
  fill?: string;
  stroke?: string;
  /** angle of the first line, degrees, in SVG user space */
  angleDeg: number;
  /** perpendicular distance between neighbouring lines inside one cell */
  spacing: number;
  strokeWidth: number;
}

export interface SvgInfo {
  path: string;
  width: number;
  height: number;
  viewBox: [number, number, number, number];
  pathCount: number;
  imageCount: number;
  patterns: SvgPattern[];
  /** pattern ids referenced by fills, in document order */
  fillRefs: string[];
}

type Attrs = Record<string, string>;

function parseAttrs(raw: string): Attrs {
  const out: Attrs = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1]] = m[2] ?? m[3] ?? '';
  return out;
}

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

/** Non-line pattern children (paths, rects, circles), with paint inherited from the cell. */
function collectShapes(body: string, cellAttrs: Attrs): CellShape[] {
  const shapes: CellShape[] = [];
  const re = /<(path|rect|circle)\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const a = parseAttrs(m[2]);
    const base: CellShape = {
      kind: m[1].toLowerCase() as 'path' | 'rect' | 'circle',
      fill: a.fill ?? cellAttrs.fill,
      stroke: a.stroke ?? cellAttrs.stroke,
      strokeWidth: num(a['stroke-width'], 0),
    };
    if (base.kind === 'path') base.ops = parsePath(a.d ?? '');
    else if (base.kind === 'rect') base.rect = [num(a.x), num(a.y), num(a.width), num(a.height)];
    else base.circle = [num(a.cx), num(a.cy), num(a.r)];
    shapes.push(base);
  }
  return shapes;
}

export function loadSvg(path: string): SvgInfo {
  const text = readFileSync(path, 'utf8');

  const svgOpen = /<svg\b([^>]*)>/i.exec(text);
  const rootAttrs = svgOpen ? parseAttrs(svgOpen[1]) : {};
  const vb = (rootAttrs.viewBox ?? '0 0 0 0').trim().split(/[\s,]+/).map(Number);

  const pathCount = (text.match(/<path\b/gi) ?? []).length;
  const imageCount = (text.match(/<image\b/gi) ?? []).length;

  const patterns: SvgPattern[] = [];
  const patternRe = /<pattern\b([^>]*)>([\s\S]*?)<\/pattern>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = patternRe.exec(text))) {
    const attrs = parseAttrs(pm[1]);
    const body = pm[2];
    const lines: SvgLine[] = [];
    const lineRe = /<line\b([^>]*?)\/?>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body))) {
      const la = parseAttrs(lm[1]);
      lines.push({
        x1: num(la.x1),
        y1: num(la.y1),
        x2: num(la.x2),
        y2: num(la.y2),
        strokeWidth: num(la['stroke-width'], 1),
      });
    }
    if (!lines.length) {
      patterns.push({
        id: attrs.id ?? `pattern${patterns.length}`,
        width: num(attrs.width),
        height: num(attrs.height),
        lines,
        shapes: collectShapes(body, attrs),
        viewBox: attrs.viewBox
          ? (attrs.viewBox.trim().split(/[\s,]+/).map(Number) as [number, number, number, number])
          : undefined,
        fill: attrs.fill,
        stroke: attrs.stroke,
        angleDeg: 0,
        spacing: 0,
        strokeWidth: 0,
      });
      continue;
    }

    const angleDeg = (Math.atan2(lines[0].y2 - lines[0].y1, lines[0].x2 - lines[0].x1) * 180) / Math.PI;
    const a = (angleDeg * Math.PI) / 180;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    const offsets = lines.map((l) => l.x1 * nx + l.y1 * ny).sort((p, q) => p - q);
    const gaps: number[] = [];
    for (let i = 1; i < offsets.length; i++) {
      const d = Math.abs(offsets[i] - offsets[i - 1]);
      if (d > 1e-6) gaps.push(d);
    }

    patterns.push({
      id: attrs.id ?? `pattern${patterns.length}`,
      width: num(attrs.width),
      height: num(attrs.height),
      lines,
      shapes: [],
      viewBox: attrs.viewBox
        ? (attrs.viewBox.trim().split(/[\s,]+/).map(Number) as [number, number, number, number])
        : undefined,
      fill: attrs.fill,
      stroke: attrs.stroke,
      angleDeg,
      spacing: median(gaps),
      strokeWidth: median(lines.map((l) => l.strokeWidth)),
    });
  }

  // pattern references in document order — one per hatch-filled shape
  const fillRefs: string[] = [];
  const fillRe = /fill\s*=\s*"url\(#([^)]+)\)"/g;
  let fm: RegExpExecArray | null;
  while ((fm = fillRe.exec(text))) fillRefs.push(fm[1]);

  return {
    path,
    width: num(rootAttrs.width),
    height: num(rootAttrs.height),
    viewBox: [vb[0] ?? 0, vb[1] ?? 0, vb[2] ?? 0, vb[3] ?? 0],
    pathCount,
    imageCount,
    patterns,
    fillRefs,
  };
}
