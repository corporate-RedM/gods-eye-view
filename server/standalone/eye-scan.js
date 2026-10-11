import net from 'node:net';
import { lookup } from 'node:dns/promises';

export async function scanHost(host, ports, signal) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(host))
    throw new Error('Enter a hostname or IP address.');
  if (
    !Array.isArray(ports) ||
    !ports.length ||
    ports.length > 32 ||
    ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)
  )
    throw new Error('Choose 1–32 TCP ports, each from 1 to 65535.');
  signal?.throwIfAborted();
  const { address } = await lookup(host);
  const pending = [...new Set(ports)];
  const results = [];
  const one = (port) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = new net.Socket();
      let open = false,
        banner = '';
      const finish = (state, error) => {
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) reject(error);
        else
          resolve({
            port,
            state,
            latencyMs: Math.round(performance.now() - started),
            banner,
          });
      };
      const abort = () =>
        finish('cancelled', signal.reason || new Error('Cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      socket.setTimeout(2000);
      socket.once('timeout', () => finish(open ? 'open' : 'timeout'));
      socket.once('error', (e) =>
        finish(e.code === 'ECONNREFUSED' ? 'closed' : 'unreachable'),
      );
      socket.once('connect', () => {
        open = true;
        socket.setTimeout(250);
      });
      socket.once('data', (chunk) => {
        banner = chunk
          .subarray(0, 512)
          .toString('utf8')
          .replace(/[^\x20-\x7e\n]/g, '');
        finish('open');
      });
      socket.once('end', () => finish(open ? 'open' : 'closed'));
      socket.connect(port, address);
    });
  await Promise.all(
    Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (pending.length) {
        signal?.throwIfAborted();
        results.push(await one(pending.shift()));
      }
    }),
  );
  return {
    host,
    address,
    transport: 'TCP connect; passive banner only',
    checkedAt: new Date().toISOString(),
    ports: results.sort((a, b) => a.port - b.port),
  };
}
export async function POST(req) {
  try {
    const body = await req.json();
    const result = await scanHost(body.host, body.ports, req.signal);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
