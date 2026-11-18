/**
 * Image XObject decoding: enough to get an 8-bit coverage (alpha) map out of the
 * narrow strips that rasterisers use for hatch fills.
 */
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';

export interface PdfCtx {
  // subset of pdf-lib's PDFContext we use
  lookup(ref: PDFRef): unknown;
  enumerateIndirectObjects(): [PDFRef, unknown][];
}

export function resolve<T>(ctx: PdfCtx, obj: unknown): T | undefined {
  let cur: any = obj;
  for (let i = 0; i < 16 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur);
  return cur as T | undefined;
}

export function dictNumber(dict: PDFDict, key: string, fallback = 0): number {
  const v = dict.lookup(PDFName.of(key));
  const n = resolve<PDFNumber>(null as any, v) ?? (v as any);
  if (n && typeof (n as any).asNumber === 'function') return (n as any).asNumber();
  if (n && typeof (n as any) === 'number') return n as any;
  return fallback;
}

export function dictName(dict: PDFDict, key: string): string | undefined {
  const v = dict.lookup(PDFName.of(key));
  // pdf-lib keeps the leading slash in PDFName#asString()
  return v instanceof PDFName ? v.asString().replace(/^\//, '') : undefined;
}

export function dictArray(dict: PDFDict, key: string): PDFArray | undefined {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFArray ? v : undefined;
}

export function streamBytes(stream: PDFRawStream, ctx: PdfCtx): Buffer {
  const raw = Buffer.from(stream.contents);
  const filterObj = stream.dict.lookup(PDFName.of('Filter'));
  const filters: string[] = [];
  const norm = (s: string): string => s.replace(/^\//, '');
  if (filterObj instanceof PDFName) filters.push(norm(filterObj.asString()));
  else if (filterObj instanceof PDFArray) {
    for (let i = 0; i < filterObj.size(); i++) {
      const f = resolve<PDFName>(ctx, filterObj.get(i));
      if (f instanceof PDFName) filters.push(norm(f.asString()));
    }
  }
  let data: Buffer = raw;
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      data = inflateSync(data);
      const parms = stream.dict.lookup(PDFName.of('DecodeParms'));
      data = applyPredictor(data, parms, ctx);
    } else {
      throw new Error(`unsupported stream filter: ${f}`);
    }
  }
  return data;
}

function applyPredictor(data: Buffer, parms: unknown, ctx: PdfCtx): Buffer {
  const p = resolve<PDFDict>(ctx, parms);
  if (!(p instanceof PDFDict)) return data;
  const predictor = dictNumber(p, 'Predictor', 1);
  if (predictor < 10) return data;
  const colors = Math.max(1, dictNumber(p, 'Colors', 1));
  const bpc = Math.max(1, dictNumber(p, 'BitsPerComponent', 8));
  const columns = Math.max(1, dictNumber(p, 'Columns', 1));
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = Buffer.from(data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)));
    const cur = Buffer.alloc(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const raw = row[i];
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v = raw;
      switch (type) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const pa = Math.abs(up - upLeft);
          const pb = Math.abs(left - upLeft);
          const pc = Math.abs(left + up - 2 * upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}
