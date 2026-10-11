// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const SNAPSHOT_VERSION = 1;
/** Overridable so a test never writes into the real cache directory. */
export const snapshotPath = () => process.env.OSIRIS_CCTV_SNAPSHOT || join(process.cwd(), '.cache', 'cctv-catalog.json');
/** Restore the catalogue written by an earlier run. */
export async function readSnapshot() {
    // 'off' keeps tests off the filesystem entirely: real disk I/O cannot be
    // flushed deterministically under fake timers, and these caches are module
    // state that leaks between cases if a read lands late.
    if (process.env.OSIRIS_CCTV_SNAPSHOT === 'off')
        return null;
    try {
        const raw = await readFile(snapshotPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version !== SNAPSHOT_VERSION || !parsed.regions)
            return null;
        return parsed;
    }
    catch {
        return null; // absent or unreadable: the catalogue simply rebuilds
    }
}
/**
 * Write via a temporary file and rename, so a crash mid-write cannot leave a
 * half-written catalogue that the next boot would refuse to parse.
 */
export async function writeSnapshot(regions) {
    const path = snapshotPath();
    const payload = { version: SNAPSHOT_VERSION, builtAt: Date.now(), regions };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload));
    await rename(temporary, path);
}
let payload;
/** Serialise and compress once, then hand the same buffers to every caller. */
export function buildPayload(body, total, complete) {
    const json = Buffer.from(JSON.stringify(body));
    payload = {
        json,
        gzip: gzipSync(json, { level: 6 }),
        etag: `W/"${createHash('sha1').update(json).digest('base64url')}"`,
        total,
        complete,
        builtAt: Date.now(),
    };
    return payload;
}
export const getPayload = () => payload;
export const clearPayload = () => { payload = undefined; };
