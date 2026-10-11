import { defineTool, ToolError } from '../tools/catalog.js';

async function read(services, path, signal) {
  const response = await services.app.fetch(
    new URL(`/api/eye/${path}`, services.app.baseUrl).href,
    { signal },
  );
  const data = await response.json();
  if (!response.ok)
    throw new ToolError(
      'unavailable',
      data.error || 'The source is unavailable.',
    );
  return data;
}
const schema = (properties) => ({
  type: 'object',
  properties,
  additionalProperties: false,
});
export const eyeTools = [
  defineTool({
    name: 'eye_news',
    title: 'News and public Telegram',
    kind: 'query',
    requires: ['app'],
    description:
      'Read source-attributed headlines and public Telegram posts. Locations may be approximate. Optional topic filter.',
    inputSchema: schema({ topic: { type: 'string' } }),
    async run({ topic = '' }, { services, signal }) {
      const body = await read(services, 'news', signal);
      const news = (body.news || []).filter(
        (n) =>
          !topic ||
          `${n.title} ${n.summary || ''}`
            .toLowerCase()
            .includes(topic.toLowerCase()),
      );
      return {
        summary: `${news.length} matching reports; social posts are unverified source reports.`,
        data: {
          news: news.slice(0, 50),
          total: news.length,
          truncated: news.length > 50,
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  }),
  defineTool({
    name: 'eye_investigate',
    title: 'Public-record investigation',
    kind: 'query',
    requires: ['app'],
    description:
      'Look up public DNS, RDAP registration, IP, certificate transparency, CVE, Bitcoin/Ethereum wallet or sanctions records. Does not scan targets.',
    inputSchema: {
      ...schema({
        kind: {
          type: 'string',
          enum: ['dns', 'whois', 'ip', 'certs', 'cve', 'crypto', 'sanctions'],
        },
        query: { type: 'string', minLength: 1, maxLength: 256 },
      }),
      required: ['kind', 'query'],
    },
    async run({ kind, query }, { services, signal }) {
      const param = {
        dns: 'domain',
        whois: 'domain',
        ip: 'ip',
        certs: 'domain',
        cve: 'cve',
        crypto: 'address',
        sanctions: 'query',
      }[kind];
      const data = await read(
        services,
        `osint/${kind}?${param}=${encodeURIComponent(query)}`,
        signal,
      );
      return { summary: `${kind.toUpperCase()} result for ${query}.`, data };
    },
  }),
  defineTool({
    name: 'eye_forecast_options',
    title: 'Forecast providers and estimated calls',
    kind: 'query',
    requires: ['app'],
    description:
      'List optional forecast providers and model-call estimates. Does not start a paid run; configure a key and explicitly start in the workspace.',
    inputSchema: schema({}),
    async run(args, { services, signal }) {
      return {
        summary:
          'Quick is the default. One active run. Provider API usage may cost money.',
        data: await read(services, 'oi', signal),
      };
    },
  }),
];
