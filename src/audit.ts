/**
 * Where do the bytes go? A per-object accounting of a PDF, grouped by role.
 * Useful to decide whether a file is worth vectorising at all.
 */
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import { dictName, dictNumber } from './images.js';

export interface AuditRow {
  category: string;
  objects: number;
  bytes: number;
}

export interface ImageRow {
  ref: string;
  width: number;
  height: number;
  kind: 'colour' | 'alpha mask' | 'other';
  bytes: number;
}

export interface AuditReport {
  file: string;
  size: number;
  streamBytes: number;
  rows: AuditRow[];
  images: ImageRow[];
}

const refKey = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber} R`;

function scanReferences(obj: unknown, ctx: any, into: Map<string, Set<string>>): void {
  const visit = (value: unknown, key: string): void => {
    if (value instanceof PDFRef) {
      const k = refKey(value);
      if (!into.has(k)) into.set(k, new Set());
      into.get(k)!.add(key);
      return;
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) visit(value.get(i), key);
      return;
    }
    if (value instanceof PDFRawStream) {
      for (const [k, v] of value.dict.entries()) visit(v, k.asString().replace(/^\//, ''));
      return;
    }
    if (value instanceof PDFDict) {
      for (const [k, v] of value.entries()) visit(v, k.asString().replace(/^\//, ''));
    }
  };
  visit(obj, 'root');
}

export async function auditPdf(file: string): Promise<AuditReport> {
  const bytes = readFileSync(file);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const ctx = doc.context as any;
  const entries = ctx.enumerateIndirectObjects() as [PDFRef, unknown][];

  const refs = new Map<string, Set<string>>();
  for (const [, obj] of entries) scanReferences(obj, ctx, refs);

  const agg = new Map<string, AuditRow>();
  const images: ImageRow[] = [];
  let streamBytes = 0;

  const add = (category: string, size: number): void => {
    const row = agg.get(category) ?? { category, objects: 0, bytes: 0 };
    row.objects++;
    row.bytes += size;
    agg.set(category, row);
  };

  for (const [ref, obj] of entries) {
    const size = obj instanceof PDFRawStream ? obj.contents.length : 0;
    streamBytes += size;
    const keys = refs.get(refKey(ref)) ?? new Set<string>();
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    const subtype = dict ? dictName(dict, 'Subtype') : undefined;

    if (subtype === 'Image') {
      const isAlpha = keys.has('SMask');
      add(isAlpha ? 'image: alpha mask (SMask)' : 'image: colour data', size);
      images.push({
        ref: refKey(ref),
        width: dict ? dictNumber(dict, 'Width') : 0,
        height: dict ? dictNumber(dict, 'Height') : 0,
        kind: isAlpha ? 'alpha mask' : 'colour',
        bytes: size,
      });
      continue;
    }
    if (keys.has('FontFile2') || keys.has('FontFile3') || keys.has('FontFile')) {
      add('font program (embedded)', size);
      continue;
    }
    if (keys.has('ToUnicode')) {
      add('font ToUnicode CMap', size);
      continue;
    }
    if (keys.has('Contents')) {
      add('page content stream', size);
      continue;
    }
    if (dict && dictNumber(dict, 'PatternType') === 1) {
      add('tiling pattern stream', size);
      continue;
    }
    if (subtype === 'Form') {
      add('form XObject', size);
      continue;
    }
    if (dict && dictName(dict, 'Type') === 'Font') {
      add('font dictionary', size);
      continue;
    }
    if (keys.has('FontDescriptor')) {
      add('font descriptor', size);
      continue;
    }
    if (dict && (dictName(dict, 'Type') === 'ExtGState' || keys.has('ExtGState'))) {
      add('graphics state', size);
      continue;
    }
    add('other object', size);
  }

  const rows = [...agg.values()].sort((a, b) => b.bytes - a.bytes);
  rows.push({
    category: 'structure (dicts, xref, header)',
    objects: 0,
    bytes: Math.max(0, bytes.length - streamBytes),
  });
  images.sort((a, b) => b.bytes - a.bytes);

  return { file, size: bytes.length, streamBytes, rows, images };
}

export function formatAudit(report: AuditReport): string {
  const pct = (v: number): string => `${((100 * v) / report.size).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`file: ${report.file}`);
  lines.push(`size: ${report.size.toLocaleString()} bytes`);
  lines.push('');
  lines.push(`${'category'.padEnd(30)} ${'objs'.padStart(5)} ${'bytes'.padStart(12)} ${'of file'.padStart(8)}`);
  lines.push('-'.repeat(59));
  for (const row of report.rows) {
    if (!row.bytes) continue;
    lines.push(
      `${row.category.padEnd(30)} ${String(row.objects || '-').padStart(5)} ${row.bytes.toLocaleString().padStart(12)} ${pct(row.bytes).padStart(8)}`,
    );
  }
  if (report.images.length) {
    lines.push('');
    lines.push('largest images (stored bytes):');
    for (const img of report.images.slice(0, 8)) {
      lines.push(
        `  ${img.ref.padEnd(10)} ${`${img.width}x${img.height}`.padEnd(12)} ${img.kind.padEnd(11)} ${img.bytes.toLocaleString().padStart(9)} B  ${pct(img.bytes)}`,
      );
    }
    const total = report.images.reduce((s, i) => s + i.bytes, 0);
    const alpha = report.images.filter((i) => i.kind === 'alpha mask').reduce((s, i) => s + i.bytes, 0);
    lines.push(`  all images: ${total.toLocaleString()} B (${pct(total)}) — alpha masks ${alpha.toLocaleString()} B (${pct(alpha)})`);
  }
  return lines.join('\n');
}
