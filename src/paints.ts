/**
 * Paint-collection helpers: walk a content stream (recursing into Form XObjects) and
 * report the page-space bbox of every painting operation, plus whether it used a
 * pattern colour.
 *
 * Used to find the WBG drawing area automatically — the drawing is whatever sits in
 * the same horizontal band as the hatched fills.
 */
import { multiply, tokenize, type Matrix } from './content.js';

export interface Paint {
  bbox: [number, number, number, number];
  pattern?: string;
  /** fill colour, when it was set with rg/g */
  fill?: [number, number, number];
  /** CTM in effect when it was painted */
  ctm: Matrix;
}

type FormLookup = (name: string, ctm: Matrix) => { content: Buffer; ctm: Matrix } | undefined;

const empty = (): [number, number, number, number] => [Infinity, Infinity, -Infinity, -Infinity];
const add = (b: [number, number, number, number], x: number, y: number): void => {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
};
const valid = (b: [number, number, number, number]): boolean => Number.isFinite(b[0]) && b[2] > b[0];

export function collectPaints(
  content: Buffer,
  baseCtm: Matrix,
  formLookup: FormLookup,
  out: Paint[] = [],
  depth = 0,
): Paint[] {
  if (depth > 6) return out;
  const stack: Matrix[] = [];
  let ctm = baseCtm;
  const path = empty();
  let started = false;
  let patternMode = false;
  let lastPattern: string | undefined;
  let fillColor: [number, number, number] | undefined;
  const operands: { kind: string; value: string }[] = [];

  const apply = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];

  for (const tok of tokenize(content)) {
    if (tok.kind !== 'op') {
      operands.push(tok);
      if (operands.length > 40) operands.shift();
      continue;
    }
    switch (tok.value) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? baseCtm;
        break;
      case 'cm': {
        const n = operands.slice(-6).filter((t) => t.kind === 'num');
        if (n.length === 6) {
          const m = n.map((t) => Number(t.value)) as Matrix;
          if (m.every(Number.isFinite)) ctm = multiply(ctm, m);
        }
        break;
      }
      case 'm':
      case 'l': {
        const n = operands.slice(-2).filter((t) => t.kind === 'num');
        if (n.length === 2) {
          const [x, y] = apply(Number(n[0].value), Number(n[1].value));
          add(path, x, y);
          started = true;
        }
        break;
      }
      case 'c': {
        const n = operands.slice(-6).filter((t) => t.kind === 'num');
        for (let i = 0; i + 1 < n.length; i += 2) {
          const [x, y] = apply(Number(n[i].value), Number(n[i + 1].value));
          add(path, x, y);
        }
        started = true;
        break;
      }
      case 're': {
        const n = operands.slice(-4).filter((t) => t.kind === 'num');
        if (n.length === 4) {
          const [x, y, w, h] = n.map((t) => Number(t.value));
          for (const [px, py] of [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ]) {
            const [ax, ay] = apply(px, py);
            add(path, ax, ay);
          }
          started = true;
        }
        break;
      }
      case 'rg': {
        const n = operands.slice(-3).filter((t) => t.kind === 'num').map((t) => Number(t.value));
        if (n.length === 3) fillColor = [n[0], n[1], n[2]];
        break;
      }
      case 'g': {
        const v = Number(operands[operands.length - 1]?.value);
        if (Number.isFinite(v)) fillColor = [v, v, v];
        break;
      }
      case 'cs': {
        const name = operands[operands.length - 1];
        patternMode = name?.kind === 'name' && name.value === 'Pattern';
        break;
      }
      case 'scn':
      case 'SCN': {
        const name = operands[operands.length - 1];
        if (name?.kind === 'name') lastPattern = name.value;
        break;
      }
      case 'f':
      case 'F':
      case 'f*':
      case 'S':
      case 's':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*': {
        if (started && valid(path)) {
          out.push({
            bbox: [path[0], path[1], path[2], path[3]],
            pattern: patternMode && lastPattern ? lastPattern : undefined,
            fill: fillColor,
            ctm,
          });
        }
        path[0] = Infinity;
        path[1] = Infinity;
        path[2] = -Infinity;
        path[3] = -Infinity;
        started = false;
        break;
      }
      case 'n': {
        path[0] = Infinity;
        path[1] = Infinity;
        path[2] = -Infinity;
        path[3] = -Infinity;
        started = false;
        break;
      }
      case 'Do': {
        const name = operands[operands.length - 1];
        if (name?.kind === 'name') {
          const form = formLookup(name.value, ctm);
          if (form) collectPaints(form.content, form.ctm, formLookup, out, depth + 1);
        }
        break;
      }
    }
    operands.length = 0;
  }
  return out;
}
