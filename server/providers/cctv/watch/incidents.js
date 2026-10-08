/**
 * Incidents for CCTV Watch: camera conditions and official reports grouped by
 * clear identity, with confidence, state, causes, links and BK's verdict.
 *
 * Merging needs clear identity:
 * - the same camera view, with a condition still open there, and compatible
 *   kinds of evidence;
 * - the same official report;
 * - an official report that names the camera itself (agencies link the
 *   cameras that watch an event).
 * Anything only near in place and time stays a separate incident, shown as
 * "possibly related" once links.js finds nothing against it. BK can link,
 * unlink or merge by hand.
 *
 * Confidence and state stay separate. An incident is resolved only when every
 * condition has ended and every report has cleared; time passing resolves
 * nothing. BK's verdict is kept as his verdict. Dismissing a notification is
 * a browser matter and never reaches this module.
 */
import { evaluateCauses, headlineFor, LEVELS } from './causes.js';
import { areaContext, areaCovers, checkLink, linkWindow } from './links.js';
import { roadOf } from './roads.js';

const LEVEL = Object.freeze({ possible: 0, likely: 1, confirmed: 2 });
const URGENCY_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 });
const URGENCY_NAMES = Object.freeze(['low', 'low', 'medium', 'high']);

/** A report last updated longer ago than this is stale and opens nothing. */
export const REPORT_INCIDENT_MAX_AGE_MS = 24 * 60 * 60_000;
/** An incident that matches a false alarm at the same camera this recently says so. */
export const FALSE_ALARM_MEMORY_MS = 24 * 60 * 60_000;
export const VERDICTS = Object.freeze(['real', 'false_alarm']);

/** Roll member states up: ongoing wins, ended needs every member ended. */
export function rollState(states) {
  if (!states.length) return 'ended';
  if (states.includes('ongoing')) return 'ongoing';
  if (states.every((state) => state === 'ended')) return 'ended';
  if (states.includes('no_recent_evidence')) return 'no_recent_evidence';
  return 'monitoring_ended';
}

/**
 * @param {object} options
 * @param {object} options.events - loadWatchEvents result.
 * @param {(id: string) => object|null} options.conditionById - Condition tracker lookup.
 * @param {(cameraId: string) => object|null} [options.cameraById] - Catalog source.
 * @param {(cameraId: string) => object|null} [options.profileOf] - Profile summary.
 * @param {(a: string, b: string) => boolean} [options.sameView] - Whether two camera ids show the same view.
 * @param {string|null} [options.cameraConfidenceCap] - Highest level camera evidence reaches without BK's verdict (thresholds config).
 */
export function createIncidentBook({
  events,
  conditionById,
  cameraById = () => null,
  profileOf = () => null,
  sameView = (a, b) => a === b,
  cameraConfidenceCap = null,
  now = Date.now,
} = {}) {
  const capLevel = LEVEL[cameraConfidenceCap] ?? LEVEL.confirmed;
  /** Incident records by id. */
  const records = new Map();
  const conditionIncident = new Map();
  const reportIncident = new Map();
  /** `${cameraId}:${type}` -> {incidentId, at} for BK's false-alarm verdicts. */
  const falseAlarms = new Map();
  /** Merged or forgotten incidents, so polling clients can drop them. */
  const removed = [];
  /** Warning and earthquake areas: group incidents, support causes. */
  let areas = [];
  /** Context cues such as scheduled events: {id, term, center, radiusKm, from, to}. */
  let cues = [];
  let revision = 0;
  let sequence = 0;
  let linksRevision = -1;
  const views = new Map();

  const compatible = (groupA, groupB) =>
    linkWindow(events, [groupA], [groupB]) !== null;

  function touch(record) {
    revision += 1;
    record.revision = revision;
  }

  function createRecord(at) {
    sequence += 1;
    const record = {
      id: `inc-${at.toString(36)}-${sequence}`,
      createdAt: at,
      conditionIds: [],
      reports: new Map(),
      verdict: null,
      linked: new Set(),
      unlinked: new Set(),
      links: [],
      /** What looks at a report's cameras found: {cameraId, from, to, readings, related}. */
      inspections: [],
      revision: 0,
    };
    records.set(record.id, record);
    return record;
  }

  const conditionsOf = (record) =>
    record.conditionIds.map((id) => conditionById(id)).filter(Boolean);

  function attachCondition(condition) {
    if (conditionIncident.has(condition.id)) return;
    const at = condition.firstSeenAt;
    let target = null;
    let targetAt = -Infinity;
    for (const record of records.values()) {
      for (const other of conditionsOf(record)) {
        if (
          other.state === 'ended' ||
          !sameView(other.cameraId, condition.cameraId) ||
          !compatible(other.group, condition.group)
        )
          continue;
        const lastAt = other.lastPresentAt ?? other.firstSeenAt;
        if (lastAt > targetAt) {
          target = record;
          targetAt = lastAt;
        }
      }
    }
    const url = cameraById(condition.cameraId)?.url;
    if (!target && url)
      for (const record of records.values())
        for (const entry of record.reports.values()) {
          const group = events.reports.get(entry.report.kind)?.group;
          if (
            !entry.clearedAt &&
            entry.report.cameraUrls?.includes(url) &&
            compatible(group, condition.group)
          )
            target = record;
        }
    target ||= createRecord(at);
    target.conditionIds.push(condition.id);
    conditionIncident.set(condition.id, target.id);
    touch(target);
  }

  function noteFalseAlarms(record, at) {
    for (const condition of conditionsOf(record))
      falseAlarms.set(`${condition.cameraId}:${condition.type}`, {
        incidentId: record.id,
        at,
      });
  }

  function distinctViews(cameraIds) {
    const kept = [];
    for (const id of cameraIds)
      if (!kept.some((other) => sameView(other, id))) kept.push(id);
    return kept.length;
  }

  function memberView(condition) {
    const lastSeen =
      [...condition.evidence]
        .reverse()
        .find((item) => item.result === 'present') || null;
    return {
      conditionId: condition.id,
      cameraId: condition.cameraId,
      confidence: condition.confidence,
      state: condition.state,
      stateReason: condition.stateReason,
      firstSeenAt: condition.firstSeenAt,
      lastPresentAt: condition.lastPresentAt,
      endedAt: condition.endedAt,
      endedBy: condition.endedBy,
      ruledOut: condition.ruledOut,
      conflict: condition.conflict ? { at: condition.conflict.at } : null,
      sightings: condition.sightings,
      measure: condition.measure,
      lastSeen,
      evidence: condition.evidence,
    };
  }

  function reportView(entry) {
    const spec = events.reports.get(entry.report.kind);
    return {
      id: entry.report.id,
      kind: entry.report.kind,
      label: spec?.label || entry.report.kind,
      title: entry.report.title,
      source: entry.report.source,
      official: entry.report.official,
      road: entry.report.road,
      direction: entry.report.direction,
      lat: entry.report.lat,
      lon: entry.report.lon,
      startedAt: entry.report.startedAt,
      updatedAt: entry.report.updatedAt,
      firstSeenAt: entry.firstSeenAt,
      changedAt: entry.changedAt,
      state: entry.clearedAt ? 'cleared' : 'listed',
      clearedAt: entry.clearedAt,
    };
  }

  function placesOf(record) {
    const places = [];
    const seen = new Set();
    for (const condition of conditionsOf(record)) {
      if (seen.has(condition.cameraId)) continue;
      seen.add(condition.cameraId);
      const camera = cameraById(condition.cameraId);
      if (!camera) continue;
      places.push({
        lat: camera.lat,
        lon: camera.lon,
        road: roadOf([camera.name]),
        cameraId: camera.id,
        camera: {
          lat: camera.lat,
          lon: camera.lon,
          headingDeg: camera.headingDeg,
          headingConfidence: camera.headingConfidence,
          fovDeg: camera.fovDeg,
        },
      });
    }
    for (const entry of record.reports.values()) {
      const report = entry.report;
      places.push({
        lat: report.lat,
        lon: report.lon,
        road: roadOf([report.road, report.direction, report.title]),
        reportId: report.id,
      });
    }
    return places;
  }

  function contextTerms(places, at) {
    const terms = new Set();
    for (const cue of cues)
      if (
        at >= cue.from &&
        at <= cue.to &&
        places.some((place) => areaCovers(cue, place))
      )
        terms.add(cue.term);
    return terms;
  }

  function buildView(record, at) {
    const members = conditionsOf(record);
    const reportEntries = [...record.reports.values()];
    const verdict = record.verdict;
    const byType = new Map();
    for (const condition of members) {
      const list = byType.get(condition.type) || [];
      list.push(condition);
      byType.set(condition.type, list);
    }
    const conditions = [];
    for (const [type, list] of byType) {
      const spec = events.observations.get(type);
      const live = list.filter((item) => item.confidence !== 'ruled_out');
      const levels = live
        .map((item) => LEVEL[item.confidence])
        .filter((level) => level !== undefined);
      const corroboration = [];
      const agreeing = reportEntries.filter(
        (entry) =>
          entry.report.official &&
          events.reports.get(entry.report.kind)?.agrees.includes(type),
      );
      let confidence;
      if (!live.length) confidence = 'ruled_out';
      else if (!levels.length) confidence = 'inconclusive';
      else {
        let level = Math.max(...levels);
        // Independent sources only: another camera's view, an official
        // report, BK. More frames from the same camera never count.
        const likelyViews = distinctViews(
          live
            .filter((item) => LEVEL[item.confidence] >= LEVEL.likely)
            .map((item) => item.cameraId),
        );
        if (likelyViews >= 2) {
          level = LEVEL.confirmed;
          corroboration.push('second camera');
        }
        if (agreeing.length) {
          level += 1;
          corroboration.push('official report');
        }
        // While detection is unvalidated nothing automatic lifts camera
        // evidence past the cap; only BK's own verdict can.
        level = Math.min(level, capLevel);
        if (verdict?.value === 'real') {
          level += 1;
          corroboration.push('your verdict');
        }
        confidence = LEVELS[Math.min(level, LEVEL.confirmed)];
      }
      const measured = list
        .map((item) => item.measure)
        .filter(Boolean)
        .sort((a, b) => b.at - a.at)[0];
      conditions.push({
        type,
        label: spec.label,
        group: spec.group,
        urgency: spec.urgency,
        persistence: spec.persistence,
        confidence,
        corroboration,
        state: rollState(list.map((item) => item.state)),
        cameras: [...new Set(live.map((item) => item.cameraId))],
        reportIds: agreeing.map((entry) => entry.report.id),
        measure: measured || null,
        members: list.map(memberView),
      });
    }

    const places = placesOf(record);
    const profiles = [...new Set(members.map((item) => item.cameraId))].map(
      (cameraId) => profileOf(cameraId),
    );
    const areaMatches = areaContext(places, areas);
    const areaReports = areas
      .filter((area) => areaMatches.some((match) => match.id === area.id))
      .map((area) => ({ kind: area.kind }));
    const { causes, explanations } = evaluateCauses(events, {
      conditions: new Map(conditions.map((item) => [item.type, item])),
      reports: reportEntries.map((entry) => entry.report),
      areaReports,
      context: contextTerms(places, at),
      profiles,
    });
    const reports = reportEntries.map(reportView);
    const headline = headlineFor({ conditions, reports, causes });

    const levels = [
      ...conditions.map((item) => LEVEL[item.confidence]),
      ...causes.map((item) => LEVEL[item.confidence]),
    ].filter((level) => level !== undefined);
    // An official report describing it is "possible" on its own.
    if (reportEntries.length) levels.push(LEVEL.possible);
    const confidence = levels.length
      ? LEVELS[Math.max(...levels)]
      : conditions.some((item) => item.confidence === 'inconclusive')
        ? 'inconclusive'
        : 'ruled_out';

    const urgencies = [
      ...conditions
        .filter((item) => item.confidence !== 'ruled_out')
        .map((item) => URGENCY_ORDER[item.urgency]),
      ...causes.map((item) => URGENCY_ORDER[item.urgency]),
      ...reportEntries.map(
        (entry) =>
          URGENCY_ORDER[events.reports.get(entry.report.kind)?.urgency] || 1,
      ),
    ];
    const memberStates = [
      ...members.map((item) => item.state),
      ...reportEntries.map((entry) => (entry.clearedAt ? 'ended' : 'ongoing')),
    ];
    const rolled = rollState(memberStates);
    const state = rolled === 'ended' ? 'resolved' : rolled;
    const reasons = members
      .filter((item) => item.state === rolled && item.stateReason)
      .map((item) => item.stateReason);

    const presentTimes = members
      .flatMap((item) => item.evidence)
      .filter((item) => item.result === 'present')
      .sort((a, b) => b.at - a.at);
    const latest = presentTimes[0] || null;
    const lastEvidenceAt = Math.max(
      record.createdAt,
      ...members.map((item) =>
        Math.max(
          item.lastPresentAt ?? -Infinity,
          item.lastDecisiveAt ?? -Infinity,
          item.endedAt ?? -Infinity,
        ),
      ),
      ...reportEntries.map((entry) =>
        Math.max(entry.changedAt, entry.clearedAt ?? -Infinity),
      ),
    );
    const resolvedAt =
      state === 'resolved'
        ? Math.max(
            ...members.map((item) => item.endedAt ?? -Infinity),
            ...reportEntries.map((entry) => entry.clearedAt ?? -Infinity),
          )
        : null;

    // A report is a reason to look. When its cameras' footage showed nothing
    // related, that is recorded as such: never a missed detection, never
    // evidence that the report was wrong, and never a change to its state.
    const inspections = record.inspections;
    const visibility = !inspections.length
      ? null
      : inspections.some((item) => item.related.length)
        ? 'related condition observed in inspected footage'
        : inspections.every((item) => item.readings === 0)
          ? 'cameras returned no footage'
          : 'reported event not visible in inspected footage';

    let similarToFalseAlarm = null;
    for (const item of members) {
      const seen = falseAlarms.get(`${item.cameraId}:${item.type}`);
      if (
        seen &&
        seen.incidentId !== record.id &&
        at - seen.at <= FALSE_ALARM_MEMORY_MS
      )
        similarToFalseAlarm = seen;
    }

    const primary =
      places.find((place) =>
        conditions.some(
          (item) =>
            item.type === headline.condition &&
            item.cameras.includes(place.cameraId),
        ),
      ) ||
      places.find((place) => Number.isFinite(place.lat)) ||
      null;

    return {
      id: record.id,
      revision: record.revision,
      createdAt: record.createdAt,
      kind: members.length ? 'camera' : 'report',
      headline,
      confidence,
      state,
      stateReason: reasons[0] || null,
      urgency: URGENCY_NAMES[Math.max(1, ...urgencies)],
      groups: [
        ...new Set([
          ...conditions.map((item) => item.group),
          ...reportEntries.map(
            (entry) => events.reports.get(entry.report.kind)?.group,
          ),
        ]),
      ].filter(Boolean),
      conditions,
      causes,
      explanations,
      reports,
      cameras: [...new Set(members.map((item) => item.cameraId))],
      location: primary
        ? {
            lat: primary.lat,
            lon: primary.lon,
            cameraId: primary.cameraId ?? null,
          }
        : null,
      places: places.map(({ camera, ...place }) => place),
      firstSeenAt: Math.min(
        ...members.map((item) => item.firstSeenAt),
        ...reportEntries.map((entry) => entry.firstSeenAt),
      ),
      lastEvidenceAt,
      resolvedAt,
      freshness: latest
        ? {
            capturedAt: latest.timeSource === 'fetch-time' ? null : latest.at,
            captureSource: latest.timeSource,
            fetchedAt: latest.fetchedAt,
            analyzedAt: latest.analyzedAt,
          }
        : null,
      verdict,
      similarToFalseAlarm,
      inspections,
      visibility,
      areas: areaMatches,
      links: record.links,
      // Internal: the full places, for link checks.
      _places: places,
    };
  }

  function refreshLinks(at) {
    if (linksRevision === revision) return;
    const active = [...records.values()].map((record) => ({
      record,
      view: viewOf(record, at),
    }));
    for (const { record, view } of active) {
      const links = [];
      for (const { record: other, view: otherView } of active) {
        if (other === record) continue;
        if (record.linked.has(other.id)) {
          links.push({
            incidentId: other.id,
            kind: 'linked',
            reasons: ['linked by you'],
          });
          continue;
        }
        if (record.unlinked.has(other.id)) continue;
        const check = checkLink(
          {
            groups: view.groups,
            places: view._places,
            firstSeenAt: view.firstSeenAt,
            resolvedAt: view.resolvedAt,
            reportIds: view.reports.map((item) => item.id),
          },
          {
            groups: otherView.groups,
            places: otherView._places,
            firstSeenAt: otherView.firstSeenAt,
            resolvedAt: otherView.resolvedAt,
            reportIds: otherView.reports.map((item) => item.id),
          },
          { events, at },
        );
        if (check?.related)
          links.push({
            incidentId: other.id,
            kind: 'possibly_related',
            reasons: check.reasons,
            distanceKm: check.distanceKm,
          });
      }
      if (JSON.stringify(links) !== JSON.stringify(record.links)) {
        record.links = links;
        touch(record);
      }
    }
    linksRevision = revision;
  }

  function viewOf(record, at) {
    const cached = views.get(record.id);
    if (cached && cached.revision === record.revision) return cached.view;
    const view = buildView(record, at);
    views.set(record.id, { revision: record.revision, view });
    return view;
  }

  function publicView(view) {
    const { _places, ...rest } = view;
    return rest;
  }

  return {
    /**
     * Apply condition changes from the tracker.
     * @param {{condition:object, change:string}[]} changes
     * @returns {string[]} Ids of incidents that changed.
     */
    applyConditionChanges(changes) {
      const touched = new Set();
      for (const { condition, change } of changes) {
        if (change === 'opened') attachCondition(condition);
        const incidentId = conditionIncident.get(condition.id);
        const record = records.get(incidentId);
        if (!record) continue;
        if (change !== 'opened') touch(record);
        touched.add(record.id);
      }
      return [...touched];
    },

    /**
     * Apply a change from the report watcher.
     * @param {{type:'new'|'updated'|'cleared', report:object, at:number, firstSeenAt:number}} change
     * @returns {string|null} Id of the incident that changed.
     */
    applyReportChange({ type, report, at, firstSeenAt }) {
      const spec = events.reports.get(report.kind);
      // Context reports and crowd-sourced ones are cues, never incidents.
      if (spec?.role !== 'evidence' || !report.official) return null;
      const existing = records.get(reportIncident.get(report.id));
      if (existing) {
        const entry = existing.reports.get(report.id);
        if (type === 'cleared') entry.clearedAt = at;
        else {
          entry.report = report;
          entry.changedAt = at;
          entry.clearedAt = null;
        }
        touch(existing);
        return existing.id;
      }
      if (type === 'cleared') return null;
      const lastUpdate = report.updatedAt ?? report.startedAt ?? firstSeenAt;
      if (at - lastUpdate > REPORT_INCIDENT_MAX_AGE_MS) return null;
      let target = null;
      if (report.cameraUrls?.length)
        for (const record of records.values())
          for (const condition of conditionsOf(record)) {
            const url = cameraById(condition.cameraId)?.url;
            if (
              condition.state !== 'ended' &&
              url &&
              report.cameraUrls.includes(url) &&
              compatible(spec.group, condition.group)
            )
              target = record;
          }
      target ||= createRecord(at);
      target.reports.set(report.id, {
        report,
        firstSeenAt: firstSeenAt ?? at,
        changedAt: at,
        clearedAt: null,
      });
      reportIncident.set(report.id, target.id);
      touch(target);
      return target.id;
    },

    /**
     * Record a look at a report's cameras: how many readings it took and any
     * compatible conditions they showed. Changes no confidence or state.
     * @param {string} reportId
     * @param {{cameraId:string, from:number, to:number, readings:number, conditions:object[]}} look
     * @returns {string|null} Id of the report's incident.
     */
    recordInspection(
      reportId,
      { cameraId, from, to, readings, conditions = [] },
    ) {
      const record = records.get(reportIncident.get(reportId));
      if (!record) return null;
      const group = events.reports.get(
        record.reports.get(reportId)?.report.kind,
      )?.group;
      const related = conditions
        .filter((condition) => group && compatible(group, condition.group))
        .map((condition) => ({
          conditionId: condition.id,
          type: condition.type,
          confidence: condition.confidence,
        }));
      record.inspections.push({ cameraId, from, to, readings, related });
      if (record.inspections.length > 20) record.inspections.shift();
      touch(record);
      return record.id;
    },

    /** BK's verdict on an incident: real, false_alarm, or null to clear it. */
    setVerdict(incidentId, value, at = now()) {
      const record = records.get(incidentId);
      if (!record) return null;
      if (value !== null && !VERDICTS.includes(value))
        throw new Error(`unknown verdict ${value}`);
      record.verdict = value ? { value, at } : null;
      if (value === 'false_alarm') noteFalseAlarms(record, at);
      touch(record);
      return record.id;
    },

    /** Link two incidents by hand. */
    link(aId, bId) {
      const a = records.get(aId);
      const b = records.get(bId);
      if (!a || !b || a === b) return false;
      a.linked.add(b.id);
      b.linked.add(a.id);
      a.unlinked.delete(b.id);
      b.unlinked.delete(a.id);
      touch(a);
      touch(b);
      return true;
    },

    /** Unlink two incidents; a suggested link between them stays hidden. */
    unlink(aId, bId) {
      const a = records.get(aId);
      const b = records.get(bId);
      if (!a || !b || a === b) return false;
      a.linked.delete(b.id);
      b.linked.delete(a.id);
      a.unlinked.add(b.id);
      b.unlinked.add(a.id);
      touch(a);
      touch(b);
      return true;
    },

    /** Merge one incident into another by hand. */
    merge(intoId, fromId) {
      const into = records.get(intoId);
      const from = records.get(fromId);
      if (!into || !from || into === from) return false;
      for (const id of from.conditionIds) {
        into.conditionIds.push(id);
        conditionIncident.set(id, into.id);
      }
      for (const [id, entry] of from.reports) {
        into.reports.set(id, entry);
        reportIncident.set(id, into.id);
      }
      into.verdict ||= from.verdict;
      into.inspections.push(...from.inspections);
      for (const id of from.linked) if (id !== into.id) into.linked.add(id);
      for (const id of from.unlinked) if (id !== into.id) into.unlinked.add(id);
      into.linked.delete(from.id);
      into.unlinked.delete(from.id);
      for (const record of records.values()) {
        if (record.linked.delete(from.id) && record !== into)
          record.linked.add(into.id);
        record.unlinked.delete(from.id);
      }
      records.delete(from.id);
      views.delete(from.id);
      touch(into);
      removed.push({ id: from.id, mergedInto: into.id, revision });
      return true;
    },

    /** Area context: warnings and earthquakes ({id, kind, label, geometry|center+radiusKm}). */
    setAreas(next) {
      areas = next;
      for (const record of records.values()) touch(record);
    },

    /** Context cues such as scheduled events ({id, term, center, radiusKm, from, to}). */
    setCues(next) {
      cues = next;
      for (const record of records.values()) touch(record);
    },

    /**
     * Incidents changed after a revision, plus those merged away or forgotten.
     * @param {object} [options]
     * @param {number} [options.since=0]
     * @param {number} [options.at]
     */
    list({ since = 0, at = now() } = {}) {
      refreshLinks(at);
      const incidents = [];
      for (const record of records.values())
        if (record.revision > since)
          incidents.push(publicView(viewOf(record, at)));
      return {
        revision,
        incidents,
        removed: removed.filter((item) => item.revision > since),
      };
    },

    get(incidentId, at = now()) {
      refreshLinks(at);
      const record = records.get(incidentId);
      return record ? publicView(viewOf(record, at)) : null;
    },

    incidentOfCondition: (conditionId) =>
      conditionIncident.get(conditionId) ?? null,

    /** Forget incidents resolved before a cutoff. */
    forget(before) {
      const at = now();
      for (const record of [...records.values()]) {
        const view = viewOf(record, at);
        if (view.state !== 'resolved' || view.lastEvidenceAt >= before)
          continue;
        records.delete(record.id);
        views.delete(record.id);
        for (const id of record.conditionIds) conditionIncident.delete(id);
        for (const id of record.reports.keys()) reportIncident.delete(id);
        revision += 1;
        removed.push({ id: record.id, mergedInto: null, revision });
      }
      for (const [key, seen] of falseAlarms)
        if (at - seen.at > FALSE_ALARM_MEMORY_MS) falseAlarms.delete(key);
      while (removed.length && removed[0].revision < revision - 10_000)
        removed.shift();
    },

    revision: () => revision,
    size: () => records.size,
  };
}
