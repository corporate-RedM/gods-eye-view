import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFullCatalog } from '../../server/providers/cctv/fullCatalog.js';
import {
  eyeCameraPacks,
  cameraToNative,
} from '../../server/standalone/eye-cameras.js';
import { osirisCameraRegions } from '../../integrations/osiris/app/api/cctv/route.js';

test('full catalogue retains over 20,000 cameras, deduplicates aliases and persists inventory across failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eye-full-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = Array.from({ length: 21001 }, (_, i) => ({
    id: `native-${i}`,
    lat: 43,
    lon: -79,
    url: `https://example.org/${i}.jpg`,
  }));
  let fail = false;
  const packs = [
    {
      name: 'native',
      enabled: () => true,
      load: async (options) => {
        assert.equal(options.fullCatalog, true);
        return native;
      },
    },
    {
      name: 'osiris-extra',
      enabled: () => true,
      load: async () => {
        if (fail) throw new Error('offline');
        return [
          { ...native[0], id: 'extra-alias' },
          {
            ...native[0],
            id: 'different-view',
            url: 'https://example.org/side.jpg',
          },
        ];
      },
    },
  ];
  const options = {
    sourceRoot: root,
    packs,
    normalize: (name, sources) => ({
      sources: sources.map((s) => ({ ...s, pack: name })),
    }),
    decorate: (s) => s,
    ttl: 60000,
  };
  const catalog = createFullCatalog(options);
  const all = await catalog.ready();
  assert.equal(all.length, 21002);
  assert.deepEqual(all.find((c) => c.id === 'native-0').aliases, [
    'extra-alias',
  ]);
  assert.equal(catalog.coverage().deduplicated, 1);
  assert.deepEqual(catalog.trimmedPacks(), []);
  fail = true;
  const restarted = createFullCatalog(options);
  assert.equal((await restarted.ready()).length, 21002);
  assert.equal(
    restarted.coverage().packs.find((p) => p.pack === 'osiris-extra').state,
    'stale',
  );
});
test('every Osiris region is registered and embedded/operator cameras survive normalization', () => {
  assert.deepEqual(
    eyeCameraPacks()
      .map((p) => p.name)
      .sort(),
    Object.keys(osirisCameraRegions)
      .map((p) => `osiris-${p}`)
      .sort(),
  );
  assert.ok(eyeCameraPacks().length > 50);
  const embed = cameraToNative(
    {
      id: 'e',
      lat: 52,
      lng: 4,
      stream_type: 'iframe',
      stream_url: 'https://www.youtube.com/embed/abc',
    },
    'test',
  );
  assert.equal(embed.feedType, 'iframe');
  assert.ok(embed.embedUrl);
  const external = cameraToNative(
    { id: 'x', lat: 52, lng: 4, external_url: 'https://example.org/camera' },
    'test',
  );
  assert.equal(external.feedType, 'external');
});
