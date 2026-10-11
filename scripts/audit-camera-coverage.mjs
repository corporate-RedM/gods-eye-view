import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { osirisCameraRegions } from '../integrations/osiris/app/api/cctv/route.js';
const base = process.env.EYE_QA_URL || 'http://127.0.0.1:4180';
const started = Date.now();
let payload;
do {
  const response = await fetch(`${base}/api/cctv/sources`, {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  const coverage = payload.coverage;
  assert.equal(coverage.mode, 'full');
  console.log(
    JSON.stringify({
      seconds: Math.round((Date.now() - started) / 1000),
      cameras: payload.sources.length,
      pending: coverage.packs
        .filter((p) => ['pending', 'loading'].includes(p.state))
        .map((p) => p.pack),
      unavailable: coverage.packs
        .filter((p) => p.state === 'unavailable')
        .map((p) => p.pack),
    }),
  );
  if (!coverage.loading) break;
  assert.ok(
    Date.now() - started < 600000,
    'Full inventory must settle within ten minutes',
  );
  await new Promise((resolve) => setTimeout(resolve, 10000));
} while (true);
const imported = payload.coverage.packs
  .filter((p) => p.pack.startsWith('osiris-'))
  .map((p) => p.pack.slice(7))
  .sort();
assert.deepEqual(imported, Object.keys(osirisCameraRegions).sort());
assert.equal(payload.trimmedPacks.length, 0);
assert.equal(
  new Set(payload.sources.map((c) => c.id)).size,
  payload.sources.length,
);
assert.ok(payload.sources.some((c) => c.feedType === 'iframe'));
assert.ok(payload.sources.some((c) => c.feedType === 'external'));
const types = {};
for (const c of payload.sources)
  types[c.feedType] = (types[c.feedType] || 0) + 1;
const report = {
  checkedAt: new Date().toISOString(),
  ...payload.coverage,
  types,
  importedRegions: imported,
  note: 'Registered camera records; inventory availability is not proof of stream playback.',
};
await fs.mkdir('output/camera-coverage', { recursive: true });
await fs.writeFile(
  'output/camera-coverage/report.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
