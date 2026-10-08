/**
 * Runs and talks to the local CCTV Watch detector (tools/cctv-detector).
 *
 * The detector is a child process of the dev server: it starts when watching
 * starts and stops with it, so nothing keeps running once the app closes. It
 * gets a minimal environment (no provider keys) and is told to stay offline,
 * so serving can never trigger a model download.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export const DETECTOR_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  LOADING: 'loading',
  READY: 'ready',
  FAILED: 'failed',
});

/** Environment variables the detector may see. Provider keys never reach it. */
const PASSED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'LD_LIBRARY_PATH',
  'CUDA_VISIBLE_DEVICES',
  'PYTORCH_CUDA_ALLOC_CONF',
];

export class DetectorUnavailableError extends Error {
  constructor(state) {
    super(`CCTV detector is ${state}`);
    this.name = 'DetectorUnavailableError';
    this.state = state;
  }
}

/** Child-process environment: the allow-list above, offline, unbuffered. */
export function detectorEnvironment(env = process.env) {
  const out = {};
  for (const key of PASSED_ENV) if (env[key] !== undefined) out[key] = env[key];
  out.PYTHONUNBUFFERED = '1';
  out.HF_HUB_OFFLINE = '1';
  out.TRANSFORMERS_OFFLINE = '1';
  return out;
}

function toBase64(bytes) {
  return Buffer.isBuffer(bytes)
    ? bytes.toString('base64')
    : Buffer.from(bytes).toString('base64');
}

/**
 * @param {object} options
 * @param {string} options.root - Repo root; relative paths resolve from here.
 * @param {string} options.python - Python executable (absolute or repo-relative).
 * @param {string} [options.script] - Detector script, repo-relative.
 * @param {number} [options.port=4191]
 */
export function createDetectorClient({
  root,
  python,
  script = 'tools/cctv-detector/detector.py',
  port = 4191,
  maxBatch = 8,
  spawnImpl = spawn,
  fetchImpl = fetch,
  log = console,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  healthEveryMs = 1000,
  readyTimeoutMs = 5 * 60 * 1000,
  stopGraceMs = 10_000,
  maxRestarts = 3,
  restartWindowMs = 10 * 60 * 1000,
} = {}) {
  const resolve = (value) =>
    path.isAbsolute(value) ? value : path.join(root, value);
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let wanted = false;
  let state = DETECTOR_STATES.STOPPED;
  let startedAt = null;
  let readyAt = null;
  let lastError = null;
  let lastHealth = null;
  let healthTimer = null;
  let killTimer = null;
  const restarts = [];

  const setState = (next, error = null) => {
    state = next;
    if (error) lastError = error;
  };

  const pipeLines = (stream, write) => {
    let buffered = '';
    stream?.setEncoding?.('utf8');
    stream?.on?.('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines)
        if (line.trim()) write(`[cctv-detector] ${line}`);
    });
  };

  const scheduleHealth = () => {
    clearTimer(healthTimer);
    healthTimer = setTimer(checkHealth, healthEveryMs);
    healthTimer?.unref?.();
  };

  async function checkHealth() {
    if (!child || !wanted) return;
    try {
      const response = await fetchImpl(`${base}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      lastHealth = await response.json();
      if (lastHealth.error) {
        setState(DETECTOR_STATES.FAILED, lastHealth.error);
        return;
      }
      if (lastHealth.ready) {
        if (state !== DETECTOR_STATES.READY) readyAt = now();
        setState(DETECTOR_STATES.READY);
      } else {
        setState(DETECTOR_STATES.LOADING);
      }
    } catch {
      // Not listening yet, or busy; the process exit handler covers crashes.
    }
    if (state !== DETECTOR_STATES.READY && now() - startedAt > readyTimeoutMs) {
      setState(DETECTOR_STATES.FAILED, 'detector did not become ready in time');
      stopChild();
      return;
    }
    // Keep a slow heartbeat once ready so the status line stays current.
    clearTimer(healthTimer);
    healthTimer = setTimer(
      checkHealth,
      state === DETECTOR_STATES.READY ? healthEveryMs * 10 : healthEveryMs,
    );
    healthTimer?.unref?.();
  }

  function stopChild() {
    const current = child;
    if (!current) return;
    try {
      current.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    clearTimer(killTimer);
    killTimer = setTimer(() => {
      try {
        current.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, stopGraceMs);
    killTimer?.unref?.();
  }

  function launch() {
    startedAt = now();
    readyAt = null;
    lastHealth = null;
    setState(DETECTOR_STATES.STARTING);
    let spawned;
    try {
      spawned = spawnImpl(
        resolve(python),
        [
          resolve(script),
          '--port',
          String(port),
          '--max-batch',
          String(maxBatch),
        ],
        {
          cwd: root,
          env: detectorEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      setState(
        DETECTOR_STATES.FAILED,
        `could not start detector: ${error.message}`,
      );
      return;
    }
    child = spawned;
    pipeLines(spawned.stdout, (line) => log.info?.(line));
    pipeLines(spawned.stderr, (line) => log.info?.(line));
    spawned.on?.('error', (error) => {
      setState(
        DETECTOR_STATES.FAILED,
        `detector process error: ${error.message}`,
      );
    });
    spawned.on?.('exit', (code, signal) => {
      if (child === spawned) child = null;
      clearTimer(healthTimer);
      clearTimer(killTimer);
      if (!wanted) {
        setState(DETECTOR_STATES.STOPPED);
        return;
      }
      const reason = `detector exited (${signal || `code ${code}`})`;
      const cutoff = now() - restartWindowMs;
      while (restarts.length && restarts[0] < cutoff) restarts.shift();
      if (state === DETECTOR_STATES.FAILED || restarts.length >= maxRestarts) {
        setState(DETECTOR_STATES.FAILED, lastError || reason);
        return;
      }
      restarts.push(now());
      log.warn?.(`[cctv-detector] ${reason}; restarting`);
      lastError = reason;
      launch();
    });
    scheduleHealth();
  }

  async function request(route, body, { timeoutMs = 120_000 } = {}) {
    if (state !== DETECTOR_STATES.READY)
      throw new DetectorUnavailableError(state);
    const response = await fetchImpl(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(
        `detector ${route} ${response.status}: ${payload?.error || 'no detail'}`,
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const frameJson = (frame) => ({
    id: frame.id,
    jpeg: toBase64(frame.jpeg),
    ...(frame.baselineKey ? { baselineKey: frame.baselineKey } : {}),
    ...(frame.learn === false ? { learn: false } : {}),
    ...(frame.captureTime !== undefined
      ? { captureTime: frame.captureTime }
      : {}),
    ...(frame.offsetSec !== undefined ? { offsetSec: frame.offsetSec } : {}),
  });

  return {
    start() {
      wanted = true;
      if (child || state === DETECTOR_STATES.READY) return;
      // An explicit start after a failure gets a fresh restart budget.
      if (state === DETECTOR_STATES.FAILED) {
        restarts.length = 0;
        lastError = null;
      }
      launch();
    },
    stop() {
      wanted = false;
      clearTimer(healthTimer);
      stopChild();
      if (!child) setState(DETECTOR_STATES.STOPPED);
    },
    status() {
      return {
        state,
        pid: child?.pid ?? null,
        startedAt,
        readyAt,
        lastError,
        restarts: restarts.length,
        health: lastHealth,
      };
    },
    isReady: () => state === DETECTOR_STATES.READY,
    /**
     * Screen frames against phrase sets; returns per-frame scores and novelty.
     * With neutral phrases, each score is measured against ordinary scenes.
     */
    screen({
      frames,
      prompts,
      neutral = [],
      priority = 5,
      learnMax,
      warmupSamples,
    }) {
      return request('/screen', {
        frames: frames.map(frameJson),
        prompts,
        ...(neutral.length ? { neutral } : {}),
        priority,
        ...(learnMax !== undefined ? { learnMax } : {}),
        ...(warmupSamples !== undefined ? { warmupSamples } : {}),
      });
    },
    /**
     * One claim's narrow question. frames: the claim's frame first, at the
     * camera's own resolution, then any sequence frames; box: where the
     * reading put the claim (0-1000). closer adds a close-up (and sequence
     * crops) cut from those frames.
     */
    verify({ frames, box, spec, closer, context = {}, priority = 5 }) {
      return request(
        '/describe',
        {
          mode: 'verify',
          frames: frames.map(frameJson),
          box,
          spec,
          closer,
          context,
          priority,
        },
        { timeoutMs: 180_000 },
      );
    },
    /** Count people in frames. */
    count({ frames, priority = 5, threshold }) {
      return request('/count', {
        frames: frames.map(frameJson),
        priority,
        ...(threshold !== undefined ? { threshold } : {}),
      });
    },
    /** One describer reading: still, pair, clip, profile or clock. */
    describe({
      mode,
      frames,
      vocabulary = [],
      context = {},
      priority = 5,
      boxes = false,
    }) {
      return request(
        '/describe',
        {
          mode,
          frames: frames.map(frameJson),
          vocabulary,
          context,
          priority,
          ...(boxes ? { boxes: true } : {}),
        },
        { timeoutMs: 180_000 },
      );
    },
    /** Feed a frame into a camera's baseline as normal, or reset it. */
    baseline({ key, action, jpeg }) {
      return request('/baseline', {
        key,
        action,
        ...(jpeg ? { jpeg: toBase64(jpeg) } : {}),
      });
    },
  };
}
