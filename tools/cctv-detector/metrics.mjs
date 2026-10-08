// Score CCTV Watch evaluation results with the same evidence rules the server
// uses, and propose screening thresholds and confirmation eligibility.
//
// Inputs: output/cctv-eval/results/*.jsonl (from evaluate.py) and the live
// screener log output/cctv-eval/screens-*.jsonl (evaluation capture).
// Output: a report on stdout and, with --propose, a proposed thresholds file
// next to the results. Nothing here edits config/cctv_watch_thresholds.json;
// BK reviews the proposal first.
//
//   node tools/cctv-detector/metrics.mjs [--propose]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWatchEvents } from '../../server/providers/cctv/watch/events.js';
import { enforceEvidenceRules } from '../../server/providers/cctv/watch/triage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evalDir = path.join(root, 'output', 'cctv-eval');
const resultsDir = path.join(evalDir, 'results');
const events = loadWatchEvents(
  JSON.parse(readFileSync(path.join(root, 'config', 'cctv_watch_events.json'), 'utf8')),
);
const TYPES = [...events.observations.keys()];
const BANDS = [0, 0.5, 0.7, 0.85, 0.95, 1.01];
/** Single-source confirmation needs this precision with at least MIN_BAND_N samples. */
const CONFIRM_PRECISION = 0.95;
const MIN_BAND_N = 10;
/** Screening budget: candidate share of ordinary live frames, per type. */
const LIVE_CANDIDATE_BUDGET = 0.004;
/**
 * Sets whose labels say, type by type, what is and is not in each item.
 * UCF-Crime labels only say which event a video holds (a road accident may
 * or may not leave a vehicle on its roof), so UCF is scored per event, never
 * per type, and stays out of calibration.
 */
const PER_TYPE_SETS = new Set(['commons', 'hpwren']);

const readJsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

function labelled(records) {
  return records.filter((r) => r.present !== null && r.present !== undefined && r.reading);
}

/** Describer verdict per type after the server's evidence rules. */
function verdicts(record) {
  const reading = enforceEvidenceRules(record.reading, record.mode, events.observations);
  const out = new Map();
  if (!reading?.ok) return out;
  for (const item of reading.observations) out.set(item.type, item);
  return out;
}

function describerReport(records, title) {
  const rows = [];
  const bands = new Map(TYPES.map((t) => [t, BANDS.slice(0, -1).map(() => ({ tp: 0, fp: 0 }))]));
  for (const type of TYPES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let unclear = 0;
    let n = 0;
    for (const record of records) {
      if (record.unsure?.includes(type) || record.video_level) continue;
      const truth = record.present.includes(type);
      const verdict = verdicts(record).get(type);
      const said = verdict?.result === 'present';
      n += 1;
      if (verdict?.result === 'unclear' && truth) unclear += 1;
      if (said && truth) tp += 1;
      else if (said && !truth) fp += 1;
      else if (!said && truth) fn += 1;
      if (said) {
        const band = BANDS.findIndex((b, i) => verdict.confidence >= b && verdict.confidence < BANDS[i + 1]);
        if (band >= 0) bands.get(type)[band][truth ? 'tp' : 'fp'] += 1;
      }
    }
    if (tp + fn + fp === 0) continue;
    rows.push({ type, n, positives: tp + fn, tp, fp, fn, unclear });
  }
  console.log(`\n## Describer — ${title} (${records.length} items)`);
  console.log('type | positives | recall | precision | false alarms | unclear on positives');
  for (const r of rows)
    console.log(
      `${r.type} | ${r.positives} | ${pct(r.tp, r.positives)} | ${pct(r.tp, r.tp + r.fp)} | ${r.fp} | ${r.unclear}`,
    );
  return { rows, bands };
}

function calibration(bandsByType) {
  console.log('\n## Calibration — precision of "present" by stated confidence (sets labelled type by type)');
  const eligible = {};
  for (const [type, bands] of bandsByType) {
    const cells = bands.map((b, i) => {
      const n = b.tp + b.fp;
      return n ? `${BANDS[i]}–${Math.min(1, BANDS[i + 1])}: ${pct(b.tp, n)} of ${n}` : null;
    });
    if (cells.every((c) => c === null)) continue;
    console.log(`${type}: ${cells.filter(Boolean).join(' · ')}`);
    // Lowest band from which every band upward clears the bar with enough samples.
    for (let i = 0; i < bands.length; i += 1) {
      const upper = bands.slice(i);
      const n = upper.reduce((s, b) => s + b.tp + b.fp, 0);
      const tp = upper.reduce((s, b) => s + b.tp, 0);
      if (n >= MIN_BAND_N && tp / n >= CONFIRM_PRECISION) {
        eligible[type] = BANDS[i];
        break;
      }
    }
  }
  return eligible;
}

function screenerReport(records, liveScreens) {
  console.log('\n## Screener — recall on labelled positives vs. candidate share of live frames');
  console.log('type | positives | threshold for 90% recall | live frames over it | proposed threshold | recall there');
  const proposed = {};
  for (const type of TYPES) {
    const spec = events.observations.get(type);
    if (!spec.phrases.length) continue;
    const pos = records
      .filter((r) => r.present?.includes(type) && r.scores && !r.unsure?.includes(type))
      .map((r) => r.scores[type])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const live = liveScreens.map((s) => s.scores?.[type]).filter(Number.isFinite).sort((a, b) => b - a);
    if (!live.length) continue;
    // Budget threshold: the score only LIVE_CANDIDATE_BUDGET of ordinary frames exceed.
    const budgetIndex = Math.min(live.length - 1, Math.floor(live.length * LIVE_CANDIDATE_BUDGET));
    const budget = live[budgetIndex];
    const recallAt = (threshold) => (pos.length ? pos.filter((s) => s >= threshold).length / pos.length : null);
    const t90 = pos.length ? pos[Math.floor(pos.length * 0.1)] : null;
    const liveOver90 = t90 === null ? null : live.filter((s) => s >= t90).length / live.length;
    proposed[type] = Number(budget.toFixed(4));
    console.log(
      `${type} | ${pos.length} | ${t90 === null ? '—' : t90.toFixed(4)} | ${liveOver90 === null ? '—' : pct(liveOver90 * live.length, live.length)} | ${budget.toFixed(4)} | ${recallAt(budget) === null ? '—' : pct(recallAt(budget) * pos.length, pos.length)}`,
    );
  }
  return proposed;
}

/** UCF annotated windows: was the class's event read as present, and was it read before it began? */
function ucfEvents(records) {
  const byClass = {};
  for (const r of records.filter((r) => r.annotated && r.reading && !r.video_level)) {
    const types = r.id.endsWith('-before') ? UCF_CLASS_TYPES[r.cls] : r.present;
    const hit = [...verdicts(r).values()].some((v) => v.result === 'present' && types.includes(v.type));
    const part = r.id.endsWith('-before') ? 'before' : r.id.endsWith('-event-still') ? 'still' : 'clip';
    byClass[r.cls] ||= { clip: { n: 0, hit: 0 }, still: { n: 0, hit: 0 }, before: { n: 0, hit: 0 } };
    byClass[r.cls][part].n += 1;
    byClass[r.cls][part].hit += hit ? 1 : 0;
  }
  if (!Object.keys(byClass).length) return;
  console.log('\n## UCF-Crime annotated events — the class read as present (any of its types)');
  console.log('class | event clip | event still | clip 20 s before the event (false reads)');
  for (const [cls, v] of Object.entries(byClass))
    console.log(`${cls} | ${v.clip.hit}/${v.clip.n} | ${v.still.hit}/${v.still.n} | ${v.before.hit}/${v.before.n}`);
}

const UCF_CLASS_TYPES = {
  Fighting: ['physical_altercation'],
  RoadAccidents: ['damaged_vehicles', 'overturned_vehicle', 'vehicle_off_road'],
  Explosion: ['smoke', 'flames'],
};

function videoLevel(records) {
  const byVideo = new Map();
  for (const r of records.filter((r) => r.video_level && r.reading)) {
    const key = r.id.replace(/-\d+$/, '');
    const entry = byVideo.get(key) || { cls: r.cls, hit: false };
    const said = [...verdicts(r).values()].some((v) => v.result === 'present' && r.present.includes(v.type));
    entry.hit ||= said;
    byVideo.set(key, entry);
  }
  if (!byVideo.size) return;
  console.log('\n## UCF-Crime video level — the event read as present in any of three clips');
  const byClass = {};
  for (const { cls, hit } of byVideo.values()) {
    byClass[cls] ||= { n: 0, hit: 0 };
    byClass[cls].n += 1;
    byClass[cls].hit += hit ? 1 : 0;
  }
  for (const [cls, v] of Object.entries(byClass)) console.log(`${cls}: ${v.hit}/${v.n} videos`);
}

/** Conditions that count as "the cameras saw it" for each report kind. */
const REPORT_EVIDENCE = {
  crash: ['damaged_vehicles', 'overturned_vehicle', 'vehicle_off_road', 'vehicle_fire', 'emergency_response', 'debris_on_road', 'traffic_stopped', 'people_on_roadway'],
  incident: ['damaged_vehicles', 'overturned_vehicle', 'vehicle_off_road', 'vehicle_fire', 'emergency_response', 'debris_on_road', 'traffic_stopped', 'people_on_roadway'],
  hazard: ['debris_on_road', 'water_on_road', 'emergency_response', 'traffic_stopped'],
  fire: ['smoke', 'flames', 'vehicle_fire'],
  flood: ['water_on_road'],
};
const REPORT_WINDOW_MS = 30 * 60_000;

function reportRecall() {
  const logDir = path.join(root, '.gev-logs', 'cctv-watch');
  if (!existsSync(logDir)) return;
  const log = readdirSync(logDir)
    .filter((f) => /^readings-.*\.jsonl$/.test(f))
    .flatMap((f) => readJsonl(path.join(logDir, f)));
  const reports = new Map();
  for (const r of log.filter((r) => r.kind === 'report' && r.change !== 'cleared'))
    if (!reports.has(r.report.id)) reports.set(r.report.id, { report: r.report, firstSeenAt: r.firstSeenAt ?? r.at });
  const sessions = new Map();
  for (const f of log.filter((r) => r.kind === 'focus' && r.reason === 'report')) {
    const list = sessions.get(f.reportId) || [];
    list.push({ cameraId: f.session.cameraId, at: f.session.startedAt, distanceKm: f.choice?.distanceKm, linked: f.choice?.linked });
    sessions.set(f.reportId, list);
  }
  const readings = log.filter((r) => r.kind === 'reading' && r.reading?.ok);
  const rows = [];
  for (const [id, list] of sessions) {
    const entry = reports.get(id);
    if (!entry) continue;
    const wanted = new Set(REPORT_EVIDENCE[entry.report.kind] || []);
    const start = Math.min(...list.map((s) => s.at));
    const cameras = new Set(list.map((s) => s.cameraId));
    const relevant = readings.filter(
      (r) => cameras.has(r.cameraId) && r.analyzedAt >= start && r.analyzedAt <= start + REPORT_WINDOW_MS,
    );
    const hits = relevant.filter((r) =>
      enforceEvidenceRules(r.reading, r.mode, events.observations).observations.some(
        (o) => o.result === 'present' && wanted.has(o.type),
      ),
    );
    const first = hits.sort((a, b) => a.analyzedAt - b.analyzedAt)[0];
    rows.push({
      id,
      kind: entry.report.kind,
      official: entry.report.official,
      title: entry.report.title.slice(0, 70),
      cameras: [...cameras],
      readings: relevant.length,
      seen: Boolean(first),
      types: first ? [...new Set(first.reading.observations.filter((o) => o.result === 'present').map((o) => o.type))] : [],
      latencyS: first ? Math.round((first.analyzedAt - start) / 1000) : null,
      frames: hits.flatMap((h) => h.evalFrames || []).slice(0, 3),
    });
  }
  if (!rows.length) return;
  // A report is a reason to look, not visual ground truth. Whether its event
  // was visible in the footage the cameras returned is checked by eye
  // (labels/report_visibility.json). An event that was not visible is
  // neither a missed detection nor proof the report was wrong.
  const visibility = existsSync(path.join(evalDir, 'labels', 'report_visibility.json'))
    ? JSON.parse(readFileSync(path.join(evalDir, 'labels', 'report_visibility.json'), 'utf8')).reports || {}
    : {};
  const category = (row) => {
    const label = visibility[row.id];
    if (label?.visible === true) return row.seen ? 'visible, flagged' : 'visible, missed';
    if (label?.visible === false) return 'reported event not visible in inspected footage';
    return row.seen ? 'flagged, footage not yet inspected' : 'not flagged, footage not yet inspected';
  };
  console.log(`\n## 511 reports that started focus (${rows.length})`);
  const counts = {};
  for (const row of rows) counts[category(row)] = (counts[category(row)] || 0) + 1;
  for (const [name, n] of Object.entries(counts)) console.log(`${name}: ${n}`);
  const visible = rows.filter((row) => visibility[row.id]?.visible === true);
  console.log(
    visible.length
      ? `visual recall over events visible in inspected footage: ${visible.filter((row) => row.seen).length}/${visible.length}`
      : 'visual recall: no reported event has been confirmed visible in inspected footage yet',
  );
  const latencies = visible.filter((r) => r.seen).map((r) => r.latencyS).sort((a, b) => a - b);
  if (latencies.length)
    console.log(`focus start to first relevant reading: p50 ${latencies[Math.floor(latencies.length / 2)]} s, p95 ${latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]} s`);
  for (const r of rows)
    console.log(`  [${category(r)}] ${r.kind}${r.official ? '' : ' (waze)'} ${r.title} | cams ${r.cameras.join(',')} | readings ${r.readings} | ${r.types.join(',')} ${r.latencyS ?? ''}${r.frames.length ? ` | ${r.frames.join(' ')}` : ''}`);
}

function liveReport(liveResults) {
  if (!liveResults.length) return;
  console.log(`\n## Live frames read by the describer (${liveResults.length}, unlabelled until checked)`);
  const counts = {};
  for (const r of liveResults)
    for (const v of verdicts(r).values())
      if (v.result === 'present') counts[v.type] = (counts[v.type] || 0) + 1;
  for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    console.log(`${type}: ${n} (${pct(n, liveResults.length)} of frames)`);
}

const sets = existsSync(resultsDir)
  ? readdirSync(resultsDir).filter((f) => f.endsWith('.jsonl'))
  : [];
const all = Object.fromEntries(sets.map((f) => [f.replace('.jsonl', ''), readJsonl(path.join(resultsDir, f))]));
const liveScreens = readdirSync(evalDir)
  .filter((f) => /^screens-.*\.jsonl$/.test(f))
  .flatMap((f) => readJsonl(path.join(evalDir, f)))
  .filter((s) => s.origin === 'sweep');
console.log(`# CCTV Watch evaluation — sets: ${sets.join(', ') || 'none'}; live screened frames: ${liveScreens.length}`);

const bandsByType = new Map(TYPES.map((t) => [t, BANDS.slice(0, -1).map(() => ({ tp: 0, fp: 0 }))]));
for (const [name, records] of Object.entries(all)) {
  if (!PER_TYPE_SETS.has(name)) continue;
  const { bands } = describerReport(labelled(records), name);
  for (const [type, list] of bands)
    list.forEach((b, i) => {
      bandsByType.get(type)[i].tp += b.tp;
      bandsByType.get(type)[i].fp += b.fp;
    });
}
if (all.ucf) {
  ucfEvents(all.ucf);
  videoLevel(all.ucf);
}
const eligible = calibration(bandsByType);
const labelledAll = Object.entries(all)
  .filter(([name]) => PER_TYPE_SETS.has(name))
  .flatMap(([, records]) => labelled(records));
const proposedScreen = screenerReport(labelledAll, liveScreens);
if (all.ucf) {
  // Would the screener at the proposed thresholds pass UCF's real events on?
  console.log('\n## Screener on UCF-Crime events — any of the class types over its proposed threshold');
  const byClass = {};
  for (const r of all.ucf.filter((r) => r.annotated && r.scores && !r.id.endsWith('-before'))) {
    const passed = UCF_CLASS_TYPES[r.cls].some((t) => Number.isFinite(proposedScreen[t]) && r.scores[t] >= proposedScreen[t]);
    byClass[r.cls] ||= { n: 0, passed: 0 };
    byClass[r.cls].n += 1;
    byClass[r.cls].passed += passed ? 1 : 0;
  }
  for (const [cls, v] of Object.entries(byClass)) console.log(`${cls}: ${v.passed}/${v.n} event clips and stills`);
}
liveReport(all.live || []);
reportRecall();

console.log('\n## Single-source confirmation eligibility (precision ≥ 95% with ≥ 10 samples)');
console.log(Object.keys(eligible).length ? JSON.stringify(eligible) : 'none yet');

if (process.argv.includes('--propose')) {
  const proposal = {
    version: 1,
    status: 'proposed',
    source: `tools/cctv-detector/metrics.mjs on ${new Date().toISOString().slice(0, 10)}: sets ${sets.join(', ')}, ${liveScreens.length} live screened frames. For BK's review; not in use.`,
    screen: { default: 0.05, ...proposedScreen },
    likely: { default: 0.85 },
    singleSourceConfirm: eligible,
    novelty: { review: 0.35, learnMax: 0.25, warmupSamples: 20 },
  };
  const file = path.join(resultsDir, 'proposed_thresholds.json');
  writeFileSync(file, `${JSON.stringify(proposal, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(root, file)}`);
}
