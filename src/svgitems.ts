/**
 * svgitems — the shared SVG layer: walk the document, carry transforms and inherited
 * paint attributes, and turn each drawable into PDF path operators.
 *
 * Everything above this file (apply, print) only deals with page coordinates.
 */
import { parsePath, type PathOp } from './svgpath.js';

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENT: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const mul = (m1: Mat, m2: Mat): Mat => ({
  a: m1.a * m2.a + m1.c * m2.b,
  b: m1.b * m2.a + m1.d * m2.b,
  c: m1.a * m2.c + m1.c * m2.d,
  d: m1.b * m2.c + m1.d * m2.d,
  e: m1.a * m2.e + m1.c * m2.f + m1.e,
  f: m1.b * m2.e + m1.d * m2.f + m1.f,
});

export function parseTransform(s: string | null | undefined): Mat {
  let m = IDENT;
  if (!s) return m;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const v = (t[2].match(/-?[\d.]+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (t[1] === 'matrix' && v.length >= 6) m = mul(m, { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] });
    else if (t[1] === 'translate') m = mul(m, { a: 1, b: 0, c: 0, d: 1, e: v[0] ?? 0, f: v[1] ?? 0 });
    else if (t[1] === 'scale') {
      const sx = v[0] ?? 1;
      m = mul(m, { a: sx, b: 0, c: 0, d: v[1] ?? sx, e: 0, f: 0 });
    } else if (t[1] === 'rotate') {
      const r = ((v[0] ?? 0) * Math.PI) / 180;
      const cs = Math.cos(r);
      const sn = Math.sin(r);
      m = mul(m, { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 });
    }
  }
  return m;
}

export interface Item {
  tag: string;
  attrs: Record<string, string>;
  m: Mat;
}

export function hexColor(v: string | null | undefined): [number, number, number] | undefined {
  if (!v) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return undefined;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function circleOps(cx: number, cy: number, r: number): PathOp[] {
  const k = 0.5522847498 * r;
  return [
    ['m', cx + r, cy],
    ['c', cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ['c', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['c', cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ['c', cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ['z'],
  ];
}

export function itemOps(item: Item): PathOp[] {
  const a = item.attrs;
  if (item.tag === 'path') return parsePath(a.d ?? '');
  if (item.tag === 'rect') {
    const x = Number(a.x ?? 0);
    const y = Number(a.y ?? 0);
    const w = Number(a.width ?? 0);
    const h = Number(a.height ?? 0);
    return [
      ['m', x, y],
      ['l', x + w, y],
      ['l', x + w, y + h],
      ['l', x, y + h],
      ['z'],
    ];
  }
  if (item.tag === 'circle') return circleOps(Number(a.cx ?? 0), Number(a.cy ?? 0), Number(a.r ?? 0));
  return [
    ['m', Number(a.x1 ?? 0), Number(a.y1 ?? 0)],
    ['l', Number(a.x2 ?? 0), Number(a.y2 ?? 0)],
  ];
}

/** walk the SVG, carrying group transforms and inherited paint attributes */
export function parseItems(text: string): Item[] {
  const items: Item[] = [];
  const stack: Mat[] = [IDENT];
  const inherited: Record<string, string>[] = [{}];
  const INHERITABLE = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity'];
  const re = /<(\/?)(svg|g|defs|path|rect|circle|line)\b([^>]*?)(\/?)>/gi;
  let defs = 0; // pattern / gradient definitions are not drawn
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const closing = !!m[1];
    const tag = m[2].toLowerCase();
    const selfClose = !!m[4];
    if (tag === 'defs') {
      if (closing) defs = Math.max(0, defs - 1);
      else if (!selfClose) defs++;
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[3]))) attrs[a[1]] = a[2];
    const isGroup = tag === 'g' || tag === 'svg';
    // a paint server is usually set on a <g> and inherited by the shapes inside it
    const parent = inherited[inherited.length - 1];
    const eff: Record<string, string> = {};
    for (const k of INHERITABLE) {
      const raw = attrs[k];
      const v = raw === undefined || raw === 'inherit' ? parent[k] : raw;
      if (v !== undefined) eff[k] = v;
    }
    if (closing) {
      if (isGroup && stack.length > 1) {
        stack.pop();
        inherited.pop();
      }
      continue;
    }
    const own = isGroup ? mul(stack[stack.length - 1], parseTransform(attrs.transform)) : stack[stack.length - 1];
    if (defs === 0 && (tag === 'path' || tag === 'rect' || tag === 'circle' || tag === 'line')) {
      items.push({ tag, attrs: { ...eff, ...attrs }, m: own });
    }
    if (isGroup && !selfClose) {
      stack.push(own);
      inherited.push(eff);
    }
  }
  return items;
}
