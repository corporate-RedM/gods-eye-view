/**
 * Live-video frames for CCTV Watch.
 *
 * Fetches a camera's newest HLS segments with the relay's own bounded,
 * same-origin helpers and decodes them to JPEG frames with ffmpeg, for
 * analysis only: video is never re-encoded and nothing is written to disk.
 * The untouched segment bytes are returned too, so motion evidence can be
 * reviewed exactly as it was received.
 */
import { spawn } from 'node:child_process';
import {
  HLS_LIMITS,
  fetchHlsBytes,
  parseHlsMedia,
  sameOriginHlsUrl,
} from '../stream.js';
import { CAPTURE_SOURCES, parseProgramDateTimes } from './freshness.js';

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * Split ffmpeg's image2pipe MJPEG output into single JPEGs. Entropy-coded
 * data byte-stuffs 0xFF, so an FFD9 pair only appears as an end marker.
 * @param {Buffer} buffer
 * @returns {Buffer[]}
 */
export function splitJpegs(buffer) {
  const frames = [];
  let start = buffer.indexOf(JPEG_START);
  while (start !== -1) {
    const end = buffer.indexOf(JPEG_END, start + 2);
    if (end === -1) break;
    frames.push(buffer.subarray(start, end + 2));
    start = buffer.indexOf(JPEG_START, end + 2);
  }
  return frames;
}

/**
 * ffmpeg arguments for decoding piped segment bytes to JPEG frames.
 * @param {object} options
 * @param {number|null} options.fps - Frames per second to sample; null for the first frame only.
 * @param {number} options.maxFrames
 * @param {number} options.maxEdge - Longest output edge in pixels.
 */
export function ffmpegFrameArgs({ fps, maxFrames, maxEdge }) {
  const scale = `scale='min(${maxEdge},iw)':-2`;
  const filter = fps ? `fps=${fps},${scale}` : scale;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-vf',
    filter,
    '-frames:v',
    String(fps ? maxFrames : 1),
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '4',
    'pipe:1',
  ];
}

/**
 * Decode concatenated segment bytes (with any fMP4 init first) to JPEGs.
 * @param {Buffer[]} parts - Init segment, then media segments, in order.
 * @returns {Promise<Buffer[]>}
 */
export function decodeFrames(
  parts,
  {
    ffmpeg = 'ffmpeg',
    fps = null,
    maxFrames = 8,
    maxEdge = 640,
    timeoutMs = 20_000,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    let child;
    try {
      child = spawnImpl(ffmpeg, ffmpegFrameArgs({ fps, maxFrames, maxEdge }), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(new Error(`could not start ffmpeg: ${error.message}`));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('ffmpeg timed out'));
    }, timeoutMs);
    const out = [];
    let errText = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (errText.length < 2000) errText += chunk;
    });
    child.on('error', (error) => finish(new Error(`ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      const frames = splitJpegs(Buffer.concat(out));
      if (frames.length) finish(null, frames);
      else
        finish(
          new Error(
            `ffmpeg produced no frames (exit ${code}): ${errText.trim().slice(0, 300)}`,
          ),
        );
    });
    child.stdin.on('error', () => {
      /* ffmpeg may close stdin early once it has its frames */
    });
    for (const part of parts) child.stdin.write(part);
    child.stdin.end();
  });
}

/**
 * Read a camera's media playlist, following a master playlist to its first
 * variant on the same origin, as the relay does.
 */
export async function readMediaPlaylist(
  url,
  { fetchImpl = fetch, signal } = {},
) {
  const read = async (target) =>
    (
      await fetchHlsBytes(target, {
        fetchImpl,
        signal,
        maxBytes: HLS_LIMITS.playlistBytes,
      })
    ).toString('utf8');
  let base = url;
  let text = await read(base);
  if (!text.includes('#EXTINF:')) {
    const variant = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!variant || !text.includes('#EXT-X-STREAM-INF:'))
      throw new Error('Missing HLS variant');
    base = sameOriginHlsUrl(variant, url);
    text = await read(base);
  }
  return { text, base };
}

/**
 * Fetch the newest segments of a live camera.
 * @param {object} source - Catalog source with an HLS `url`.
 * @param {object} [options]
 * @param {number} [options.sinceSeq=-1] - Only segments after this media sequence.
 * @param {number} [options.maxSegments=1] - Newest segments to fetch.
 * @param {Map<string, Buffer>} [options.initCache] - Init segments by URI.
 * @returns {Promise<{segments:object[], init:{uri:string, bytes:Buffer}|null, fetchedAt:number}>}
 */
export async function fetchNewestSegments(
  source,
  {
    sinceSeq = -1,
    maxSegments = 1,
    initCache = new Map(),
    fetchImpl = fetch,
    signal,
    now = Date.now,
  } = {},
) {
  const { text, base } = await readMediaPlaylist(source.url, {
    fetchImpl,
    signal,
  });
  const fetchedAt = now();
  const dates = parseProgramDateTimes(text);
  const listed = parseHlsMedia(text, base);
  const fresh = listed.filter((segment) => segment.seq > sinceSeq);
  const chosen = fresh.slice(-maxSegments);
  if (new Set(chosen.map((segment) => segment.map)).size > 1)
    throw new Error('Mixed HLS init segments');
  const map = chosen[0]?.map ?? null;
  let init = null;
  if (map) {
    let bytes = initCache.get(map);
    if (!bytes) {
      bytes = await fetchHlsBytes(map, {
        fetchImpl,
        signal,
        maxBytes: HLS_LIMITS.segmentBytes,
      });
      initCache.set(map, bytes);
    }
    init = { uri: map, bytes };
  }
  const segments = [];
  for (const segment of chosen) {
    const bytes = await fetchHlsBytes(segment.uri, {
      fetchImpl,
      signal,
      maxBytes: HLS_LIMITS.segmentBytes,
    });
    segments.push({
      seq: segment.seq,
      duration: segment.duration,
      uri: segment.uri,
      bytes,
      capturedAt: dates.get(segment.seq) ?? null,
    });
  }
  return {
    segments,
    init,
    fetchedAt,
    newestSeq: listed.at(-1)?.seq ?? sinceSeq,
  };
}

/**
 * Decode fetched segments into dated frames.
 * Each frame's capture time is its segment's program date-time plus its offset
 * when the playlist dates segments, and unknown otherwise.
 * @returns {Promise<object[]>} Frames: {jpeg, offsetSec, captureTime, captureSource, seq}.
 */
export async function framesFromSegments(
  { segments, init },
  {
    fps = null,
    maxFrames = 8,
    maxEdge = 640,
    ffmpeg = 'ffmpeg',
    spawnImpl,
  } = {},
) {
  if (!segments.length) return [];
  const parts = [
    ...(init ? [init.bytes] : []),
    ...segments.map((s) => s.bytes),
  ];
  const jpegs = await decodeFrames(parts, {
    ffmpeg,
    fps,
    maxFrames,
    maxEdge,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  const start = segments[0];
  return jpegs.map((jpeg, index) => {
    const offsetSec = fps ? index / fps : 0;
    const captureTime =
      start.capturedAt !== null ? start.capturedAt + offsetSec * 1000 : null;
    return {
      jpeg,
      offsetSec,
      captureTime,
      captureSource:
        captureTime !== null
          ? CAPTURE_SOURCES.PROGRAM_DATE_TIME
          : CAPTURE_SOURCES.UNKNOWN,
      seq: start.seq,
    };
  });
}
