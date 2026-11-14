import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// PDF fonts, CMaps and image decoders stay bundled; never fetch them from a CDN.
const source = resolve('node_modules/pdfjs-dist');
const target = resolve('public/pdfjs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'LICENSE']) cpSync(`${source}/${name}`, `${target}/${name}`, { recursive: true });
cpSync(`${source}/legacy/build/pdf.worker.min.mjs`, `${target}/pdf.worker.mjs`);
