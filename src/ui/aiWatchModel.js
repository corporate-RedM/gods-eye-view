/**
 * AI Watch wording and feed bookkeeping, kept free of the DOM.
 *
 * BK's rules (2026-10-08): AI Watch is off until he presses Start; its
 * status always reads plainly (off, starting, running, stopping); its
 * notifications never move the view, open a camera or take focus, and the
 * one way from a notification to a camera is his click on "View camera",
 * handled like choosing the camera from the CCTV dropdown.
 */

import {
  cameraPackForId,
  englishCameraName,
  englishPlaceName,
} from '../data/englishNames.js';

/** The last area BK chose: a preference only, never a reason to start. */
export const AI_WATCH_AREA_STORAGE_KEY = 'gev:ai-watch-area:v1';

/**
 * What the control should say and allow for a server status.
 * @param {object|null} watch - GET /api/cctv/watch/state `watch`.
 */
export function describeWatchStatus(watch) {
  const status = statusFor(watch);
  return {
    ...status,
    stopLabel: status.state === 'stopping' ? 'Stopping…' : 'Stop AI Watch',
  };
}

function statusFor(watch) {
  const state = watch?.state ?? 'unknown';
  const area = watch?.area?.label;
  const budget = watch?.gpuBudget;
  const share = budget ? `${Math.round(budget.share * 100)}% GPU budget` : '';
  switch (state) {
    case 'starting':
      return {
        state,
        label: 'AI Watch: Starting',
        detail: `Loading the models for ${area ?? 'the chosen area'}…`,
        canStart: false,
        canStop: true,
      };
    case 'running':
      return {
        state,
        label: 'AI Watch: Running',
        detail: [
          `Watching ${area ?? 'the chosen area'}`,
          watch?.area?.cameras ? `${watch.area.cameras} cameras` : '',
          share,
        ]
          .filter(Boolean)
          .join(' · '),
        canStart: false,
        canStop: true,
      };
    case 'stopping':
      return {
        state,
        label: 'AI Watch: Stopping',
        detail: 'Ending readings and releasing the GPU…',
        canStart: false,
        canStop: false,
      };
    case 'failed':
      return {
        state,
        label: 'AI Watch: Off (failed)',
        detail: watch?.lastError || 'The detector could not start.',
        canStart: true,
        canStop: false,
      };
    case 'disabled':
      return {
        state,
        label: 'AI Watch: Unavailable',
        detail: 'AI Watch is turned off in this setup.',
        canStart: false,
        canStop: false,
      };
    case 'off':
      return {
        state,
        label: 'AI Watch: Off',
        detail: 'Choose an area, then start. Nothing runs until you do.',
        canStart: true,
        canStop: false,
      };
    default:
      return {
        state: 'unknown',
        label: 'AI Watch: Unknown',
        detail: 'The server is not answering.',
        canStart: false,
        canStop: false,
      };
  }
}

/**
 * Fold a feed response into the entries shown, one per incident: a repeat
 * sighting updates its entry in place. An entry is unread when it is new or
 * has changed since BK last opened the feed.
 * @param {Map<string, object>} entries - Current entries by id (mutated).
 * @param {object[]} incoming - Notifications from GET /notifications.
 * @param {Map<string, number>} seen - Revision BK last saw per id.
 * @returns {{list: object[], unread: number}}
 */
export function mergeNotifications(entries, incoming, seen) {
  for (const entry of incoming) {
    if (entry?.id) entries.set(entry.id, entry);
  }
  const list = [...entries.values()].sort(
    (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
  );
  const unread = list.filter(
    (entry) => (seen.get(entry.id) ?? -1) < (entry.revision ?? 0),
  ).length;
  return { list, unread };
}

/** "Unverified" unless a narrow check confirmed it; everything stays possible. */
export function verificationLabel(entry) {
  return entry?.verification === 'checked'
    ? 'Possible · checked'
    : 'Possible · unverified';
}

/** One notification's second line: how sure, where, how often, how recent. */
export function describeEntry(entry, now = Date.now()) {
  const settled = entry.state === 'ongoing';
  return [
    verificationLabel(entry),
    entry.cameraName
      ? englishCameraName(entry.cameraName, cameraPackForId(entry.cameraId))
      : entry.cameraId,
    englishPlaceName(entry.place ?? ''),
    entry.sightings > 1 ? `seen ${entry.sightings} times` : '',
    formatAgo(entry.lastSeenAt, now),
    settled
      ? ''
      : entry.stateReason || String(entry.state).replaceAll('_', ' '),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "3 min ago" style age. */
export function formatAgo(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The most specific area chosen in the three pickers. */
export function chosenAreaId({ region, city, municipality }) {
  return municipality || city || region || null;
}
