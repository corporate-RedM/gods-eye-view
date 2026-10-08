/**
 * The AI Watch notification feed (BK, 2026-10-08). One entry per camera
 * incident, so an observation seen again updates its entry rather than
 * adding another, and each entry says plainly whether a check has settled
 * it. A notification only offers a camera to view: nothing here, or in the
 * app, moves the view, opens a camera or takes focus on its own.
 */

/**
 * @param {object[]} incidents - Incident views from the evidence model.
 * @param {(cameraId: string) => object|null} [cameraById]
 * @returns {object[]} Newest sighting first.
 */
export function notificationsFrom(incidents, cameraById = () => null) {
  return incidents
    .filter((incident) => incident.kind === 'camera')
    .map((incident) => {
      const members = incident.conditions.flatMap(
        (condition) => condition.members ?? [],
      );
      const cameraId =
        incident.location?.cameraId ?? incident.cameras?.[0] ?? null;
      const camera = cameraId ? cameraById(cameraId) : null;
      // Checked: the latest sighting of some condition was confirmed by its
      // narrow question. Everything else (no question for the type, an
      // unsettled or dropped check) is unverified.
      const checked = members.some(
        (member) =>
          member.lastSeen?.support?.verification?.answer &&
          !member.lastSeen.support.unverified,
      );
      return {
        id: incident.id,
        revision: incident.revision,
        title:
          incident.headline?.text ??
          incident.conditions[0]?.label ??
          'Observation',
        types: incident.conditions.map((condition) => condition.type),
        confidence: incident.confidence,
        verification: checked ? 'checked' : 'unverified',
        state: incident.state,
        stateReason: incident.stateReason ?? null,
        urgency: incident.urgency,
        cameraId,
        cameraName: camera?.name ?? null,
        place: camera?.city ?? null,
        sightings: members.reduce(
          (sum, member) => sum + (member.sightings || 0),
          0,
        ),
        firstSeenAt: incident.firstSeenAt,
        lastSeenAt: incident.lastEvidenceAt ?? incident.firstSeenAt,
      };
    })
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}
