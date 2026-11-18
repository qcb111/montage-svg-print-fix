/**
 * Minimal SVG path parser: enough for the machine-generated geometry in these
 * drawings (M/L/H/V/C/S/Q/T/A/Z, absolute and relative). Arcs are converted to
 * cubic segments so the PDF side only ever sees lines and cubics.
 */
export type PathOp =
  | ['m', number, number]
  | ['l', number, number]
  | ['c', number, number, number, number, number, number]
  | ['z'];

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

interface Tok {
  cmd?: string;
  num?: number;
}

function tokenize(d: string): Tok[] {
  const out: Tok[] = [];
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(d))) {
    if (m[1]) out.push({ cmd: m[1] });
    else if (m[2] !== undefined) out.push({ num: Number(m[2]) });
  }
  return out;
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x1: number, y1: number): PathOp {
  const c1x = x0 + (2 / 3) * (qx - x0);
  const c1y = y0 + (2 / 3) * (qy - y0);
  const c2x = x1 + (2 / 3) * (qx - x1);
  const c2y = y1 + (2 / 3) * (qy - y1);
  return ['c', c1x, c1y, c2x, c2y, x1, y1];
}

function arcToCubics(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  rotDeg: number,
  largeArc: number,
  sweep: number,
  x1: number,
  y1: number,
): PathOp[] {
  if (!rx || !ry) return [['l', x1, y1]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = den ? sign * Math.sqrt(num / den) : 0;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (!n) return 0;
    const a = Math.acos(Math.max(-1, Math.min(1, dot / n)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const t = (4 / 3) * Math.tan(step / 4);
  const out: PathOp[] = [];
  let theta = start;
  for (let i = 0; i < segments; i++) {
    const c1 = Math.cos(theta);
    const s1 = Math.sin(theta);
    const c2 = Math.cos(theta + step);
    const s2 = Math.sin(theta + step);
    const e1x = cosPhi * rx * c1 - sinPhi * ry * s1 + cx;
    const e1y = sinPhi * rx * c1 + cosPhi * ry * s1 + cy;
    const e2x = cosPhi * rx * c2 - sinPhi * ry * s2 + cx;
    const e2y = sinPhi * rx * c2 + cosPhi * ry * s2 + cy;
    const d1x = -cosPhi * rx * s1 - sinPhi * ry * c1;
    const d1y = -sinPhi * rx * s1 + cosPhi * ry * c1;
    const d2x = -cosPhi * rx * s2 - sinPhi * ry * c2;
    const d2y = -sinPhi * rx * s2 + cosPhi * ry * c2;
    out.push(['c', e1x + t * d1x, e1y + t * d1y, e2x - t * d2x, e2y - t * d2y, e2x, e2y]);
    theta += step;
  }
  return out;
}

export function parsePath(d: string): PathOp[] {
  const toks = tokenize(d);
  const ops: PathOp[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = '';
  let prevCtrl: [number, number] | null = null;
  let prevQuad: [number, number] | null = null;

  const num = (): number => {
    while (i < toks.length && toks[i].num === undefined) i++;
    return toks[i++]?.num ?? 0;
  };
  const hasNum = (): boolean => i < toks.length && toks[i].num !== undefined;

  while (i < toks.length) {
    const tk = toks[i];
    if (tk.cmd) {
      cmd = tk.cmd;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        ops.push(['z']);
        cx = sx;
        cy = sy;
        prevCtrl = prevQuad = null;
        continue;
      }
    }
    if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    switch (up) {
      case 'M': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        ops.push(['m', x, y]);
        cmd = rel ? 'l' : 'L';
        prevCtrl = prevQuad = null;
        break;
      }
      case 'L': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        ops.push(['l', x, y]);
        cx = x;
        cy = y;
        prevCtrl = prevQuad = null;
        break;
      }
      case 'H': {
        let x = num();
        if (rel) x += cx;
        ops.push(['l', x, cy]);
        cx = x;
        prevCtrl = prevQuad = null;
        break;
      }
      case 'V': {
        let y = num();
        if (rel) y += cy;
        ops.push(['l', cx, y]);
        cy = y;
        prevCtrl = prevQuad = null;
        break;
      }
      case 'C': {
        let x1 = num();
        let y1 = num();
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        ops.push(['c', x1, y1, x2, y2, x, y]);
        prevCtrl = [x2, y2];
        prevQuad = null;
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const x1 = prevCtrl ? 2 * cx - prevCtrl[0] : cx;
        const y1 = prevCtrl ? 2 * cy - prevCtrl[1] : cy;
        ops.push(['c', x1, y1, x2, y2, x, y]);
        prevCtrl = [x2, y2];
        prevQuad = null;
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        let qx = num();
        let qy = num();
        let x = num();
        let y = num();
        if (rel) {
          qx += cx;
          qy += cy;
          x += cx;
          y += cy;
        }
        ops.push(quadToCubic(cx, cy, qx, qy, x, y));
        prevQuad = [qx, qy];
        prevCtrl = null;
        cx = x;
        cy = y;
        break;
      }
      case 'T': {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        const qx: number = prevQuad ? 2 * cx - prevQuad[0] : cx;
        const qy: number = prevQuad ? 2 * cy - prevQuad[1] : cy;
        ops.push(quadToCubic(cx, cy, qx, qy, x, y));
        prevQuad = [qx, qy];
        prevCtrl = null;
        cx = x;
        cy = y;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        ops.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y));
        prevCtrl = prevQuad = null;
        cx = x;
        cy = y;
        break;
      }
      default:
        i++;
    }
    if (!hasNum() && i < toks.length && toks[i].cmd) continue;
  }
  return ops;
}

/** Serialise path ops into PDF path operators, mapping every point through `map`. */
export function pathToPdf(
  ops: PathOp[],
  map: (x: number, y: number) => [number, number],
  fmt: (v: number) => string,
): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op[0] === 'm') {
      const p = map(op[1], op[2]);
      out.push(`${fmt(p[0])} ${fmt(p[1])} m`);
    } else if (op[0] === 'l') {
      const p = map(op[1], op[2]);
      out.push(`${fmt(p[0])} ${fmt(p[1])} l`);
    } else if (op[0] === 'c') {
      const a = map(op[1], op[2]);
      const b = map(op[3], op[4]);
      const c = map(op[5], op[6]);
      out.push(`${fmt(a[0])} ${fmt(a[1])} ${fmt(b[0])} ${fmt(b[1])} ${fmt(c[0])} ${fmt(c[1])} c`);
    } else {
      out.push('h');
    }
  }
  return out;
}
