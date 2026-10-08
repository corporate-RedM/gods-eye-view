/**
 * HTTP routes for CCTV Watch, mounted under /api/cctv/watch/ by the CCTV
 * proxy. Reading state is open like the other camera routes; anything that
 * changes what the watch does answers only this machine, through the same
 * admission gate as Provider Settings.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { admitKeySetupRequest } from '../../../../src/keySetupCore.mjs';

const MAX_BODY_BYTES = 8 * 1024;

async function sendEvidence(res, resolved) {
  if (!resolved) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let info;
  try {
    info = await stat(resolved.file);
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (!info.isFile()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  // Evidence files never change once written.
  res.writeHead(200, {
    'Content-Type': resolved.contentType,
    'Content-Length': info.size,
    'Cache-Control': 'private, max-age=86400',
  });
  createReadStream(resolved.file).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Admission for routes that change the watch. */
export function admitWatchControl(req, env = process.env) {
  const decision = admitKeySetupRequest({
    method: req.method,
    remoteAddress: req.socket?.remoteAddress,
    hostHeader: req.headers?.host,
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    origin: req.headers?.origin,
    contentType: req.headers?.['content-type'],
    proxyHeaders: req.headers || {},
    env,
  });
  if (decision.ok) return decision;
  // Same refusal, worded for this surface.
  return {
    ok: false,
    status: decision.status,
    error: 'CCTV Watch controls answer only this machine',
  };
}

/**
 * Handle one /watch/... request.
 * @param {object} watch - createCctvWatch() instance.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url - Parsed URL whose pathname starts with /watch/.
 */
export async function handleWatchRoute(watch, req, res, url) {
  const route = url.pathname.slice('/watch'.length);

  if (req.method === 'GET' && route === '/state') {
    // An open app keeps a running Watch alive; no request here starts it.
    if (url.searchParams.get('keepalive') === '1') watch.touch();
    sendJson(res, 200, { watch: watch.status() });
    return;
  }

  if (req.method === 'GET' && route === '/areas') {
    try {
      sendJson(res, 200, await watch.areas());
    } catch (error) {
      sendJson(res, 503, {
        error: `Camera list unavailable: ${error.message}`,
      });
    }
    return;
  }

  if (req.method === 'GET' && route === '/notifications') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    sendJson(res, 200, watch.notifications({ since }));
    return;
  }

  if (req.method === 'GET' && route === '/readings') {
    const limit = Math.max(
      1,
      Math.min(300, Number(url.searchParams.get('limit')) || 50),
    );
    sendJson(res, 200, { readings: watch.recentReadings(limit) });
    return;
  }

  if (req.method === 'GET' && route === '/reports') {
    sendJson(res, 200, { reports: watch.currentReports() });
    return;
  }

  if (req.method === 'GET' && route === '/incidents') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    sendJson(res, 200, watch.incidents({ since }));
    return;
  }

  if (req.method === 'GET' && route.startsWith('/evidence/')) {
    const parts = route.slice('/evidence/'.length).split('/');
    const resolved =
      parts.length === 4
        ? watch.evidenceFile(...parts.map((part) => decodeURIComponent(part)))
        : null;
    await sendEvidence(res, resolved);
    return;
  }

  const admitted = admitWatchControl(req);
  if (!admitted.ok) {
    sendJson(res, admitted.status, { error: admitted.error });
    return;
  }

  if (req.method === 'POST' && route === '/start') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Body must be a small JSON object' });
      return;
    }
    const result = await watch.start({ area: body?.area });
    sendJson(res, result.ok ? 200 : 409, { ...result, watch: watch.status() });
    return;
  }

  if (req.method === 'POST' && route === '/stop') {
    watch.stop();
    sendJson(res, 200, { watch: watch.status() });
    return;
  }

  if (req.method === 'POST' && route === '/focus') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Body must be a small JSON object' });
      return;
    }
    if (typeof body?.cameraId !== 'string' || !body.cameraId) {
      sendJson(res, 400, { error: 'cameraId is required' });
      return;
    }
    const result = watch.watchCamera({
      cameraId: body.cameraId,
      minutes: body.minutes,
    });
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === 'DELETE' && route.startsWith('/focus/')) {
    const stopped = watch.stopWatching(
      decodeURIComponent(route.slice('/focus/'.length)),
    );
    sendJson(res, stopped ? 200 : 404, { ok: stopped });
    return;
  }

  if (req.method === 'POST' && route.startsWith('/incidents/')) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Body must be a small JSON object' });
      return;
    }
    const action = route.slice('/incidents/'.length);
    if (action === 'verdict') {
      // BK's verdict: real, false_alarm, or null to clear it. It is recorded
      // as his verdict and never rewrites what the cameras showed.
      if (![null, 'real', 'false_alarm'].includes(body?.value ?? null)) {
        sendJson(res, 400, {
          error: 'value must be real, false_alarm or null',
        });
        return;
      }
      const id = watch.setVerdict(
        String(body?.incidentId || ''),
        body.value ?? null,
      );
      sendJson(res, id ? 200 : 404, { ok: Boolean(id) });
      return;
    }
    const pair = [body?.a ?? body?.into, body?.b ?? body?.from].map((value) =>
      String(value || ''),
    );
    const handlers = {
      link: () => watch.linkIncidents(...pair),
      unlink: () => watch.unlinkIncidents(...pair),
      merge: () => watch.mergeIncidents(...pair),
    };
    if (!handlers[action]) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ok = handlers[action]();
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
