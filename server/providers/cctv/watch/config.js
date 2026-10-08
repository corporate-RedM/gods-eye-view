/**
 * CCTV Watch settings, read from the environment when watching starts (not at
 * import, because Vite copies .env into process.env after modules load).
 * Every number here is a starting value to be re-set from measurement.
 */
import path from 'node:path';

function intFrom(env, name, fallback, min, max) {
  const value = Number.parseInt(env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function floatFrom(env, name, fallback, min, max) {
  const value = Number.parseFloat(env[name] ?? '');
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {object} env - Usually process.env.
 * @param {string} root - Repo root.
 */
export function readWatchConfig(env = process.env, root = process.cwd()) {
  return Object.freeze({
    enabled: env.CCTV_WATCH_ENABLED !== '0',
    root,
    python: env.CCTV_WATCH_PYTHON || 'tools/cctv-detector/venv/bin/python',
    detectorScript: 'tools/cctv-detector/detector.py',
    detectorPort: intFrom(env, 'CCTV_WATCH_DETECTOR_PORT', 4191, 1024, 65535),
    describeBatch: intFrom(env, 'CCTV_WATCH_DESCRIBE_BATCH', 8, 1, 32),
    ffmpeg: env.CCTV_WATCH_FFMPEG || 'ffmpeg',
    ffmpegConcurrency: intFrom(env, 'CCTV_WATCH_FFMPEG_CONCURRENCY', 6, 1, 32),
    idleStopMs: intFrom(
      env,
      'CCTV_WATCH_IDLE_STOP_MS',
      5 * 60_000,
      60_000,
      60 * 60_000,
    ),
    sweepConcurrency: intFrom(env, 'CCTV_WATCH_SWEEP_CONCURRENCY', 24, 1, 128),
    hostConcurrency: intFrom(env, 'CCTV_WATCH_HOST_CONCURRENCY', 4, 1, 32),
    // 8 while detection is evaluated; resized from measured queue growth.
    focusSlots: intFrom(env, 'CCTV_WATCH_FOCUS_MAX', 8, 0, 64),
    // Share of wall time Watch may keep the GPU busy, across every model
    // call (BK, 2026-10-08: 20%). Unlimited watching ran it near 90%.
    gpuBudget: floatFrom(env, 'CCTV_WATCH_GPU_BUDGET', 0.2, 0.02, 1),
    patrolSlots: intFrom(env, 'CCTV_WATCH_PATROL_SLOTS', 2, 0, 8),
    scheduleShare: floatFrom(env, 'CCTV_WATCH_SCHEDULE_SHARE', 0.25, 0, 1),
    clipEveryMs: intFrom(env, 'CCTV_WATCH_CLIP_EVERY_SEC', 45, 10, 600) * 1000,
    spikeMinGapMs:
      intFrom(env, 'CCTV_WATCH_SPIKE_MIN_GAP_SEC', 30, 0, 600) * 1000,
    // A camera whose still has stopped changing is read from its live video.
    staleStillVideo: env.CCTV_WATCH_STALE_STILL_VIDEO !== '0',
    auditRate: floatFrom(env, 'CCTV_WATCH_AUDIT_RATE', 0.02, 0, 1),
    reports: env.CCTV_WATCH_REPORTS !== '0',
    reportPollMs:
      intFrom(env, 'CCTV_WATCH_REPORT_POLL_SEC', 120, 30, 3600) * 1000,
    evalCapture: env.CCTV_WATCH_EVAL_CAPTURE === '1',
    cacheDir: path.join(root, '.gev-cache', 'cctv-watch'),
    logDir: path.join(root, '.gev-logs', 'cctv-watch'),
    evalDir: path.join(root, 'output', 'cctv-eval'),
    evidenceDir: path.join(root, 'output', 'cctv-evidence'),
  });
}
