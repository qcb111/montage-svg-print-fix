#!/usr/bin/env node
/**
 * pdf-column-vectorizer
 *
 *   apply --pdf <report.pdf> --svg <drawing.svg> --rect x0,y0,x1,y1 [--out <out.pdf>]
 *       Replace the rasterised drawing inside the report with the one from the SVG,
 *       emitted as vector. The rest of the page is left untouched.
 *
 *   print --svg <drawing.svg> [--out <out.pdf>]
 *       Same emitter, standalone: one page the size of the viewBox, 1 unit = 1 pt.
 *
 *   shrink --pdf <in.pdf> [--svg <drawing.svg>]
 *       No SVG at hand: crop each periodic raster texture down to one tile.
 *
 *   audit <file.pdf>
 *       Where do the bytes go? Groups every object by role.
 *
 *   audit <file.pdf>
 *       Where do the bytes go? Groups every object by role.
 */
import { existsSync } from 'node:fs';
import { auditPdf, formatAudit } from './audit.js';
import { loadSvg } from './svg.js';
import { printSvg } from './print.js';
import { applyPdf } from './apply.js';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

const asBool = (v: string | true | undefined): boolean => v === true || v === 'true' || v === '1';
const asNum = (v: string | true | undefined, d: number): number => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d);
const asStr = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function usage(): void {
  console.log(`pdf-column-vectorizer

  apply --pdf <report.pdf> --svg <drawing.svg> --rect x0,y0,x1,y1
        replace the drawn column with the SVG, as vector
  print --svg <drawing.svg>       standalone vector PDF, 1 unit = 1 pt
  audit <file.pdf>                byte accounting per object role

apply options:
  --out <file.pdf>       output path (default: "<in> vector.pdf")
  --rect x0,y0,x1,y1     box the drawing occupied in the report (PDF points)
  --cover a0,b0,a1,b1    area to erase first (default: --rect)
  --dry-run              analyse, do not write
  --json                 machine readable output
`);
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const json = asBool(flags.get('json'));

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'audit') {
    const file = positional[0] ?? asStr(flags.get('pdf'));
    if (!file || !existsSync(file)) {
      console.error('audit: missing or unreadable PDF');
      process.exitCode = 2;
      return;
    }
    const report = await auditPdf(file);
    console.log(json ? JSON.stringify(report, null, 2) : formatAudit(report));
    return;
  }

  if (command === 'apply') {
    const input = asStr(flags.get('pdf')) ?? positional[0];
    const svgPath = asStr(flags.get('svg'));
    if (!input || !existsSync(input) || !svgPath || !existsSync(svgPath)) {
      console.error('apply: need --pdf and --svg');
      process.exitCode = 2;
      return;
    }
    const report = await applyPdf({
      input,
      svg: svgPath,
      output: asStr(flags.get('out')),
      cover: (() => {
        const r = asStr(flags.get('cover'));
        if (!r) return undefined;
        const v = r.split(',').map(Number);
        return v.length === 4 && v.every((n) => Number.isFinite(n))
          ? ([v[0], v[1], v[2], v[3]] as [number, number, number, number])
          : undefined;
      })(),      rect: (() => {
        const r = asStr(flags.get('rect'));
        if (!r) return undefined;
        const v = r.split(',').map(Number);
        return v.length === 4 && v.every((n) => Number.isFinite(n))
          ? ([v[0], v[1], v[2], v[3]] as [number, number, number, number])
          : undefined;
      })(),
      dryRun: asBool(flags.get('dry-run')),
    });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`  anchor band: ${report.from.map((v) => v.toFixed(1)).join(', ')}`);
      console.log(`  scale: ${report.scale[0]} x ${report.scale[1]}`);
      console.log(`  drawn: ${report.shapes} shapes, ${report.patterns} patterns, ${report.texts} text runs`);
      for (const w of report.warnings) console.log('  ! ' + w);
      console.log(`  image objects: ${report.imagesBefore} -> ${report.imagesAfter}`);
      if (!asBool(flags.get('dry-run'))) {
        console.log(`  file size: ${(report.sizeBefore / 1024).toFixed(1)} KB -> ${(report.sizeAfter / 1024).toFixed(1)} KB`);
        console.log(`  written: ${report.output}`);
      }
    }
    return;
  }
  if (command === 'print') {
    const svgPath = asStr(flags.get('svg')) ?? positional[0];
    if (!svgPath || !existsSync(svgPath)) {
      console.error('print: missing or unreadable --svg');
      process.exitCode = 2;
      return;
    }
    const out = asStr(flags.get('out')) ?? svgPath.replace(/\.svg$/i, '.pdf');
    const report = await printSvg(svgPath, out);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`  page: ${report.page[0]} x ${report.page[1]} pt (1 SVG unit = 1 pt)`);
      console.log(`  drawn: ${report.shapes} shapes, ${report.patterns} tiling patterns`);
      console.log(`  file size: ${(report.size / 1024).toFixed(1)} KB`);
      console.log(`  written: ${report.output}`);
    }
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
