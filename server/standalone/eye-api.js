import { Readable } from 'node:stream';
import { isLocalMcpRequest } from '../mcp/plugin.js';

const modules = {
  'news/route.js': () =>
    import('../../integrations/osiris/app/api/news/route.js'),
  'region-dossier/route.js': () =>
    import('../../integrations/osiris/app/api/region-dossier/route.js'),
  'oi/route.js': () => import('../../integrations/osiris/app/api/oi/route.js'),
  'oi/runs/route.js': () =>
    import('../../integrations/osiris/app/api/oi/runs/route.js'),
  'oi/runs/[id]/route.js': () =>
    import('../../integrations/osiris/app/api/oi/runs/[id]/route.js'),
  'oi/runs/[id]/events/route.js': () =>
    import('../../integrations/osiris/app/api/oi/runs/[id]/events/route.js'),
  'oi/runs/[id]/ask/route.js': () =>
    import('../../integrations/osiris/app/api/oi/runs/[id]/ask/route.js'),
  'oi/runs/[id]/inject/route.js': () =>
    import('../../integrations/osiris/app/api/oi/runs/[id]/inject/route.js'),
  'osint/dns/route.js': () =>
    import('../../integrations/osiris/app/api/osint/dns/route.js'),
  'osint/whois/route.js': () =>
    import('../../integrations/osiris/app/api/osint/whois/route.js'),
  'osint/ip/route.js': () =>
    import('../../integrations/osiris/app/api/osint/ip/route.js'),
  'osint/certs/route.js': () =>
    import('../../integrations/osiris/app/api/osint/certs/route.js'),
  'osint/cve/route.js': () =>
    import('../../integrations/osiris/app/api/osint/cve/route.js'),
  'osint/crypto/route.js': () =>
    import('../../integrations/osiris/app/api/osint/crypto/route.js'),
  'osint/sanctions/route.js': () =>
    import('../../integrations/osiris/app/api/osint/sanctions/route.js'),
};
const routes = new Set([
  'news',
  'region-dossier',
  'oi',
  'oi/runs',
  ...['dns', 'whois', 'ip', 'certs', 'cve', 'crypto', 'sanctions'].map(
    (n) => `osint/${n}`,
  ),
]);

export function eyeRoute(pathname) {
  const key = pathname.replace(/^\/api\/eye\//, '').replace(/\/$/, '');
  if (routes.has(key)) return { module: `${key}/route.js`, params: {} };
  const run = /^oi\/runs\/([a-f0-9-]{36})(?:\/(events|ask|inject))?$/.exec(key);
  return run
    ? {
        module: `oi/runs/[id]/${run[2] ? run[2] + '/' : ''}route.js`,
        params: { id: run[1] },
      }
    : null;
}

export function eyeApiPlugin({ getSources } = {}) {
  const ready = import('../../integrations/osiris/lib/vision/frames.js').then(
    (module) => {
      if (getSources) module.setCatalogueReader(getSources);
    },
  );
  const install = (server) => {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/eye/')) return next();
      const respond = (status, error) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error }));
      };
      if (
        !isLocalMcpRequest({
          remoteAddress: req.socket.remoteAddress,
          localPort: req.socket.localPort,
          host: req.headers.host,
          origin: req.headers.origin,
          headers: req.headers,
          env: process.env,
        })
      )
        return respond(403, 'This workspace is available locally only.');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = eyeRoute(url.pathname);
      if (!route) return respond(404, 'Unknown workspace endpoint.');
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        await ready;
        const chunks = [];
        let size = 0;
        req.setTimeout(30_000, () => req.destroy());
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 240_000) return respond(413, 'Request too large.');
          chunks.push(chunk);
        }
        const module = await modules[route.module]();
        if (typeof module[req.method] !== 'function')
          return respond(405, 'Method not supported.');
        const request = new Request(url, {
          method: req.method,
          headers: req.headers,
          signal: controller.signal,
          ...(!['GET', 'HEAD'].includes(req.method)
            ? { body: Buffer.concat(chunks) }
            : {}),
        });
        const response = await module[req.method](request, {
          params: Promise.resolve(route.params),
        });
        res.writeHead(response.status, {
          ...Object.fromEntries(response.headers),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (!response.body) return res.end();
        const stream = Readable.fromWeb(response.body);
        controller.signal.addEventListener('abort', () => stream.destroy(), {
          once: true,
        });
        stream.on('error', () => {
          if (!res.destroyed) res.end();
        });
        stream.pipe(res);
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return;
        if (res.headersSent) return res.end();
        // Do not return provider exceptions that might carry request headers or keys.
        console.warn('[Eye workspace]', error?.name || 'Request failed');
        respond(502, 'The source could not answer. Try again shortly.');
      }
    });
  };
  return {
    name: 'childs-eye-workspace',
    configureServer: install,
    configurePreviewServer: install,
  };
}
