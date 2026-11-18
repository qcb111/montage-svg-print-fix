/**
 * Content-stream scanning.
 *
 * Only the operators that matter for image placement are interpreted:
 *   q / Q   graphics state stack
 *   cm      concatenate matrix
 *   Do      paint XObject
 *
 * The scanner also reports byte offsets so the caller can cut whole `q ... Q`
 * blocks that paint images out of the stream without touching anything else.
 */

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

export interface Token {
  kind: 'num' | 'name' | 'op' | 'other';
  value: string;
  start: number;
  end: number;
}

export function tokenize(buf: Buffer): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const c = buf[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
      continue;
    }
    const start = i;
    if (c === 0x2f) {
      i++;
      while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
      out.push({ kind: 'name', value: buf.toString('latin1', start + 1, i), start, end: i });
      continue;
    }
    if (c === 0x28) {
      i++;
      let depth = 1;
      while (i < n && depth > 0) {
        if (buf[i] === 0x5c) {
          i += 2;
          continue;
        }
        if (buf[i] === 0x28) depth++;
        else if (buf[i] === 0x29) depth--;
        i++;
      }
      out.push({ kind: 'other', value: 'string', start, end: i });
      continue;
    }
    if (c === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        i += 2;
        out.push({ kind: 'other', value: '<<', start, end: i });
        continue;
      }
      const end = buf.indexOf(0x3e, i);
      i = end === -1 ? n : end + 1;
      out.push({ kind: 'other', value: 'hexstring', start, end: i });
      continue;
    }
    if (c === 0x3e && buf[i + 1] === 0x3e) {
      i += 2;
      out.push({ kind: 'other', value: '>>', start, end: i });
      continue;
    }
    if (DELIM.has(c)) {
      i++;
      out.push({ kind: 'other', value: String.fromCharCode(c), start, end: i });
      continue;
    }
    while (i < n && !WS.has(buf[i]) && !DELIM.has(buf[i])) i++;
    const value = buf.toString('latin1', start, i);
    out.push({ kind: /^[-+]?(\d+\.?\d*|\.\d+)$/.test(value) ? 'num' : 'op', value, start, end: i });
  }
  return out;
}
