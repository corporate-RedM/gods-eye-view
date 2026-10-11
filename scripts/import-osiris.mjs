/** Print an auditable patch; the caller applies it with the editor tool.
 * Usage: node scripts/import-osiris.mjs /path/to/osiris
 * The import is pinned by docs/OSIRIS-NOTICE.md. No network or file writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const source = path.resolve(process.argv[2]);
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript');
const entries = [
  'app/api/news/route', 'app/api/region-dossier/route',
  ...['dns','whois','ip','certs','cve','crypto','sanctions'].map(n => `app/api/osint/${n}/route`),
  'app/api/oi/route', 'app/api/oi/runs/route',
  ...['','events/','ask/','inject/'].map(n => `app/api/oi/runs/[id]/${n}route`),
  ...['asfinag','netherlands','japan','hongkong','sweden','oregon','edmonton','florida','taiwan','newzealand','france','spain'].map(n => `app/api/cctv/${n}`),
  'lib/vision/client', 'lib/vision/vision.worker',
];
const files = new Map();
const external = new Set();
function visit(id) {
  id = id.replace(/\.ts$/, '');
  if (files.has(id)) return;
  files.set(id, '');
  const filename = path.join(source, 'src', id + '.ts');
  let code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  function specifier(s) {
    if (s === 'next/server') return path.posix.relative(path.posix.dirname(id), 'next-shim.js').replace(/^(?!\.)/, './');
    if (s.startsWith('@/') || s.startsWith('.')) {
      const target = (s.startsWith('@/') ? s.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(id), s))).replace(/\.ts$/, '');
      visit(target);
      return path.posix.relative(path.posix.dirname(id), target + '.js').replace(/^(?!\.)/, './');
    }
    external.add(s);
    return s;
  }
  code = code.replace(/(from\s*|import\s*\(\s*|import\s*)(['"])([^'"]+)\2/g,
    (all, lead, quote, spec) => `${lead}${quote}${specifier(spec)}${quote}`);
  code = code.replaceAll('./vision.worker.ts', './vision.worker.js');
  code = code.replace(/(?<=['"`}])\/api\//g, '/api/eye/');
  files.set(id, '// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.\n' + code);
}
for (const entry of entries) visit(entry);
const all = [...files].map(([id, code]) => ({ path: `integrations/osiris/${id}.js`, code }));
const offset = Number(process.argv[3] || 0);
const count = Number(process.argv[4] || 0);
const output = JSON.stringify({ external: [...external], total: all.length, files: count ? all : all.map(f => ({ path: f.path, bytes: f.code.length })) });
process.stdout.write(count ? output.slice(offset, offset + count) : output);
