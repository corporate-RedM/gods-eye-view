import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoChat } from '../../integrations/osiris/lib/oi/demo.js';
import { startPrediction } from '../../integrations/osiris/lib/oi/service.js';
import {
  startRun,
  cancelRun,
  waitForEnd,
  ownsRun,
  runSummary,
} from '../../integrations/osiris/lib/oi/runs.js';
import { PROVIDERS } from '../../integrations/osiris/lib/oi/providers.js';
import { GET as events } from '../../integrations/osiris/app/api/oi/runs/[id]/events/route.js';

test('native research defaults to Quick, completes with injected fixtures, streams replay and keeps credentials out of exports', async () => {
  assert.equal(
    PROVIDERS.some((p) => p.id === 'demo'),
    false,
  );
  const result = startPrediction(
    {
      question: 'Will the envoys sign an agreement this year?',
      use_feeds: false,
    },
    { provider: 'openai', key: 'sk-fixture-never-sent', model: 'fixture' },
    'fixture',
    { chat: createDemoChat() },
  );
  assert.ok(result.ok);
  await waitForEnd(result.run, 10000);
  assert.equal(result.run.state.status, 'done');
  const summary = runSummary(result.run, 'http://localhost:4176');
  assert.equal(summary.depth, 'quick');
  assert.ok(summary.report);
  assert.doesNotMatch(JSON.stringify(summary), /sk-fixture-never-sent/);
  assert.ok(ownsRun(result.run, result.run.token));
  assert.equal(ownsRun(result.run, 'wrong'), false);
  const response = await events(
    new Request('http://localhost/api/eye/oi/runs/x/events'),
    { params: Promise.resolve({ id: result.run.id }) },
  );
  const replay = await response.text();
  assert.match(replay, /data:/);
  assert.match(replay, /"t":"end"/);
});

test('one active research run is enforced and cancellation ends work', async () => {
  const chat = createDemoChat([15, 15]);
  const input = {
    question: 'Will the envoys sign an agreement this year?',
    seed: '',
    depth: 'quick',
    useFeeds: false,
    provider: 'openai',
    model: 'fixture',
    key: 'fixture-key',
    ip: 'fixture',
  };
  const first = startRun(input, { chat });
  assert.ok(first.ok);
  const second = startRun({ ...input, ip: 'another' }, { chat });
  assert.equal(second.ok, false);
  assert.equal(second.status, 503);
  assert.ok(cancelRun(first.run));
  await waitForEnd(first.run, 5000);
  assert.equal(first.run.state.status, 'cancelled');
});
