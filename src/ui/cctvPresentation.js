import { createCctvVideoSurface } from './cctvVideo.js';
import { englishProviderName } from '../data/englishNames.js';
import { syncMjpegFrame } from './cctvFrames.js';
import { populateCameraOptions } from './cctvCameraList.js';

/**
 * The panel's title lines: which camera is open and where it is, from city
 * to continent ("Tallinn · Harju County · Estonia · Europe"). The place line
 * comes from the shell's `describeCameraPlace` (ui/whereAmI.js).
 */
function renderCameraTitle(nameEl, placeEl, enabled, camera, describePlace) {
  const name = !enabled
    ? 'CCTV is off'
    : camera
      ? camera.name
      : 'No camera open';
  const place =
    enabled && camera
      ? describePlace?.(camera) || String(camera.city || '')
      : '';
  if (nameEl && nameEl.textContent !== name) nameEl.textContent = name;
  if (placeEl && placeEl.textContent !== place) placeEl.textContent = place;
}
export function _calBadgeLabel(badge) {
  switch (badge) {
    case 'calibrated':
      return 'CALIBRATED';
    case 'curated':
      return 'CURATED';
    case 'raw-prior':
      return 'RAW PRIOR';
    default:
      return '--';
  }
}

export function _renderCctvState(state) {
  if (this.destroyed) return;
  if (
    !state?.enabled ||
    !this.actions.isEnabled() ||
    state?.activeCameraId !== this._cctvState?.activeCameraId
  ) {
    this._calibrationEdit?.(false);
  }
  this._cctvState = state || null;
  const cameras = state?.cameras || [];
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = state?.activeCameraId || '';
  const activeCamera = state?.activeCamera || null;

  // Auto-expand the panel when the active camera CHANGES to a new non-null
  // id while the layer is enabled. Covers click-on-globe, panel controls,
  // and voice (selectCamera/cycleCamera/focusNearest all notify through
  // this subscription). The last-seen guard keeps routine notifications
  // from re-expanding a panel the user deliberately collapsed, and timed
  // auto-hop transitions only expand on the first activation so the panel
  // does not pop open on every hop.
  const effectiveActiveId = enabled ? activeId || null : null;
  const isFirstActivation = this._lastSeenCctvActiveId === null;
  if (
    effectiveActiveId &&
    effectiveActiveId !== this._lastSeenCctvActiveId &&
    (!state?.autoHop || isFirstActivation)
  ) {
    this.actions.setPanelCollapsed('cctv-panel', false, {
      explicit: Boolean(state?.explicitSelection),
    });
  }
  this._lastSeenCctvActiveId = effectiveActiveId;

  this._updateCctvSyncChip(enabled);

  if (this._cctvEnableBtn) {
    this._cctvEnableBtn.classList.toggle('active', enabled);
    this._cctvEnableBtn.textContent = enabled ? 'CCTV ON' : 'CCTV OFF';
  }

  if (this._cctvSelect) {
    if (state?.liveOnly && this._cctvFeedFilter?.value === 'snapshot')
      this._cctvFeedFilter.value = 'all';
    // The feed filter (All feeds / Live video / Snapshots) narrows the dropdown
    // and the search suggestions to cameras of that feed type only.
    const feedFilter = this._cctvFeedFilter?.value || 'all';
    const matchesFilter = (cam) =>
      feedFilter === 'all' || (feedFilter === 'live') === !!cam.isVideo;
    // Keep the complete list stable while typing. The native datalist filters
    // suggestions; rebuilding it from the typed label can discard a selection
    // before its change event reaches the camera picker.
    const listed = cameras.filter(matchesFilter);
    if (this._cctvSearch)
      this._cctvSearch.placeholder = `Search all ${listed.length.toLocaleString()} cameras`;
    // isVideo and liveFailed are part of the signature: a stream that falls
    // back to its still image moves the camera from Live video to Snapshots,
    // labelled LIVE OFFLINE.
    const signature = `${feedFilter}|${activeId}|${listed
      .map((cam) =>
        cam.isVideo ? `${cam.id}+` : cam.liveFailed ? `${cam.id}!` : cam.id,
      )
      .join(',')}`;
    if (signature !== this._cctvListSignature) {
      this._cctvListSignature = signature;
      if (this._cctvFeedFilter) {
        const live = cameras.filter((cam) => cam.isVideo).length;
        const counts = {
          all: cameras.length,
          live,
          snapshot: cameras.length - live,
        };
        for (const option of this._cctvFeedFilter.options) {
          const base = option.textContent.replace(/ \([\d,]+\)$/, '');
          option.textContent = `${base} (${counts[option.value].toLocaleString()})`;
        }
      }
      this._cctvSelect.innerHTML = '';
      this._cctvSearchMatch = this._cctvSearchIds?.get(
        this._cctvSearch?.value?.trim(),
      );
      // The search box suggests these same labels; duplicate labels get the
      // camera id appended so every suggestion resolves to exactly one camera.
      this._cctvSearchIds = new Map();
      if (this._cctvSearchOptions) this._cctvSearchOptions.innerHTML = '';
      populateCameraOptions(this, listed, signature);
    }
    this._cctvSelect.disabled =
      !enabled || cameras.length === 0 || !!this._cctvListPending;
    if (this._cctvSearch) this._cctvSearch.disabled = this._cctvSelect.disabled;
    if (this._cctvSelect.disabled) this._cctvPicker?.close();
    if (this._cctvFeedFilter)
      this._cctvFeedFilter.disabled = this._cctvSelect.disabled;
    if (
      activeId &&
      Array.from(this._cctvSelect.options).some((opt) => opt.value === activeId)
    ) {
      this._cctvSelect.value = activeId;
    } else {
      // No active camera, or one outside the feed filter: show no selection
      // rather than a listed camera that is not the one playing.
      this._cctvSelect.selectedIndex = -1;
    }
  }

  for (const btn of [
    this._cctvNearestBtn,
    this._cctvPrevBtn,
    this._cctvNextBtn,
  ]) {
    if (!btn) continue;
    btn.disabled = !enabled || cameras.length === 0;
  }
  if (this._cctvFocusBtn) {
    this._cctvFocusBtn.disabled = !enabled || cameras.length === 0 || !activeId;
  }

  if (this._cctvCoverageBtn) {
    // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
    // (color-coded volumes). The click handler cycles; this renders.
    const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
    this._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
    this._cctvCoverageBtn.textContent =
      mode === 'viewshed'
        ? 'VIEWSHED ON'
        : mode === 'on'
          ? 'COVERAGE ON'
          : 'COVERAGE OFF';
    this._cctvCoverageBtn.disabled = !enabled;
  }

  if (this._cctvAutoHopBtn) {
    const autoHop = !!state?.autoHop;
    this._cctvAutoHopBtn.classList.toggle('active', autoHop);
    this._cctvAutoHopBtn.textContent = autoHop ? 'AUTO HOP ON' : 'AUTO HOP OFF';
    this._cctvAutoHopBtn.disabled = !enabled;
  }

  if (this._cctvProjectionBtn) {
    const showProjection = state?.showProjection !== false;
    this._cctvProjectionBtn.classList.toggle('active', showProjection);
    this._cctvProjectionBtn.textContent = showProjection
      ? 'PROJECTION ON'
      : 'PROJECTION OFF';
    this._cctvProjectionBtn.disabled = !enabled;
  }

  if (this._cctvQualityChip) {
    // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
    // no in-world tint): three states driven by cctv.js's deriveCalBadge,
    // no client-side scoring math. Casing is unified via _calBadgeLabel so
    // the chip and the meta line never drift onto different conventions.
    // Save-gated persistence (viewshed design §3e): unsaved live edits show
    // EDITED on top of whatever the persisted badge state is — SAVE CAL
    // promotes to CALIBRATED, RESET CAL clears.
    const badge = activeCamera?.calBadge || null;
    const dirty = !!activeCamera?.calDirty;
    this._cctvQualityChip.textContent = dirty
      ? 'CAL · EDITED (UNSAVED)'
      : `CAL · ${this._calBadgeLabel(badge)}`;
    this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
  }

  this._syncCctvCalReadout(enabled, activeCamera);
  renderCameraTitle(
    this._cctvCameraName,
    this._cctvCameraPlace,
    enabled,
    activeCamera,
    this.actions.describeCameraPlace,
  );

  if (this._cctvMeta) {
    if (activeCamera) {
      const provider = englishProviderName(
        activeCamera.sourceLabel ||
          activeCamera.provider ||
          'Configured Source',
      );
      const statusMsg = activeCamera.sourceMessage
        ? ` · ${activeCamera.sourceMessage}`
        : '';
      // A partner-supplied feed inside a pack names its owner here.
      const credit = activeCamera.credit ? ` · ${activeCamera.credit}` : '';
      const calBadge = activeCamera.calBadge
        ? this._calBadgeLabel(activeCamera.calBadge)
        : '';
      const projLabel = state?.showProjection !== false ? 'MONITOR' : 'OFF';
      this._cctvMeta.textContent = `${activeCamera.city} · HDG ${Math.round(activeCamera.headingDeg)}° · FOV ${Math.round(activeCamera.fovDeg)}° · RANGE ${Math.round(activeCamera.rangeM)}m · ${projLabel}${calBadge ? ` · ${calBadge}` : ''} · ${provider}${credit}${statusMsg}`;
    } else if (cameras.length > 0) {
      this._cctvMeta.textContent = enabled
        ? `${cameras.length} cameras loaded · click a camera to activate`
        : `${cameras.length} cameras loaded · enable CCTV to activate`;
    } else {
      this._cctvMeta.textContent = 'Enable CCTV to load camera intersections';
    }
  }

  const liveIntent =
    enabled && !!activeCamera?.isVideo && !activeCamera.liveFailed;
  const mjpegIntent = liveIntent && activeCamera.feedType === 'mjpeg';
  const videoIntent =
    liveIntent && !mjpegIntent && activeCamera.feedType !== 'iframe';
  const externalIntent =
    enabled && ['iframe', 'external'].includes(activeCamera?.feedType);
  const externalVisible =
    externalIntent &&
    !document.hidden &&
    !this._cctvPanel?.classList.contains('collapsed');
  if (
    this._cctvExternalPanel &&
    (!externalVisible || this._cctvExternalCameraId !== activeId)
  ) {
    this._cctvExternalPanel.remove();
    this._cctvExternalPanel = null;
  }
  if (externalVisible && !this._cctvExternalPanel && this._cctvFrameWrap) {
    const panel = document.createElement('div');
    panel.className = 'cctv-external-player';
    if (activeCamera.embedUrl) {
      const frame = document.createElement('iframe');
      frame.title = activeCamera.name;
      frame.referrerPolicy = 'no-referrer';
      frame.sandbox = 'allow-scripts allow-same-origin allow-presentation';
      frame.allow = 'autoplay; fullscreen; picture-in-picture';
      frame.src = activeCamera.embedUrl;
      frame.style.cssText = 'width:100%;aspect-ratio:16/9;border:0';
      panel.append(frame);
    }
    const link = document.createElement('a');
    link.href = activeCamera.externalUrl || activeCamera.embedUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open camera on operator website';
    panel.append(link);
    this._cctvFrameWrap.append(panel);
    this._cctvExternalPanel = panel;
    this._cctvExternalCameraId = activeId;
  }
  if (this._cctvVideo) {
    this._cctvVideo.hidden = !videoIntent;
    if (this._cctvFrame) this._cctvFrame.hidden = videoIntent || externalIntent;
    const visible =
      videoIntent &&
      !document.hidden &&
      !this._cctvPanel?.classList.contains('collapsed');
    if (!visible || this._cctvVideoCameraId !== activeId) {
      this._cctvVideoSurface?.stop();
      this._cctvVideoSurface = null;
    }
    this._cctvVideoCameraId = activeId;
    if (visible && !this._cctvVideoSurface) {
      this._cctvVideoSurface = createCctvVideoSurface(
        this._cctvVideo,
        () => this.cctv.getActiveVideoElement?.(),
        {
          // Full resolution (up to 1080p) while the feed is maximized.
          maxWidth: () =>
            document.fullscreenElement === this._cctvFrameWrap ? 1920 : 640,
        },
      );
    }
  }

  syncMjpegFrame(
    this,
    activeCamera,
    mjpegIntent &&
      !document.hidden &&
      !this._cctvPanel?.classList.contains('collapsed'),
  );

  if (this._cctvFrame && !liveIntent) {
    const nextSrc = enabled && !externalIntent ? activeCamera?.frameUrl : null;
    const nextCameraId = enabled ? activeCamera?.id || '' : '';
    const cameraChanged = this._cctvFrame.dataset.cameraId !== nextCameraId;
    const frameLoading = this._cctvFrame.dataset.loading === 'true';
    // A same-camera refresh waits for the current image to settle. Replacing
    // src every 10 seconds can cancel a slow but healthy decode forever and
    // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
    // immediate so navigation never waits on the prior camera's request.
    if (
      nextSrc &&
      (cameraChanged ||
        (!frameLoading && this._cctvFrame.dataset.currentSrc !== nextSrc))
    ) {
      this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged);
    }
    if (!nextSrc) {
      this._clearCctvFrame();
    }
  } else if (liveIntent && !mjpegIntent) {
    this._clearCctvFrame();
  }

  this._syncCctvSourceBadge(activeCamera, enabled);
  this._typeCctvSummary(
    state?.summary ||
      'Enable CCTV to start camera-linked intelligence summaries.',
  );
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || 'No summary available.';
  if (nextText === this._lastCctvSummaryText) return;
  this._lastCctvSummaryText = nextText;

  clearInterval(this._cctvSummaryTypingTimer);
  this._cctvSummary.textContent = '';
  let idx = 0;
  this._cctvSummaryTypingTimer = setInterval(() => {
    if (this.destroyed) return;
    idx += 3;
    if (idx >= nextText.length) {
      this._cctvSummary.textContent = nextText;
      clearInterval(this._cctvSummaryTypingTimer);
      this._cctvSummaryTypingTimer = null;
      return;
    }
    this._cctvSummary.textContent = nextText.slice(0, idx);
  }, 20);
}

export function _updateCctvSyncChip(enabled) {
  if (this.destroyed) return;
  if (!this._cctvSyncChip || !this._cctvSyncLabel || !this._cctvSyncProgress)
    return;
  const catalogue = this._cctvState?.catalogueLoading;
  const busy = !!catalogue?.active;
  const count = Number(this._cctvState?.count) || 0;
  const total = catalogue?.total ?? count;
  const loaded = catalogue?.loaded ?? count;
  const format = (value) => Number(value || 0).toLocaleString('en-US');
  this._cctvSyncChip.title =
    'Full camera catalogue registered in this browser. Video feeds open on demand.';
  // init runs before the layer becomes enabled: its real progress must be visible too.
  this._cctvSyncChip.classList.toggle('visible', busy || enabled);
  const failed =
    catalogue?.phase === 'error' || catalogue?.phase === 'cancelled';
  this.actions.setSplitFlapText(
    this._cctvSyncLabel,
    busy
      ? catalogue.total == null
        ? 'collecting camera catalogue'
        : 'loading frames'
      : failed
        ? 'camera catalogue incomplete'
        : 'camera grid ready',
  );
  const placed = busy && catalogue.phase !== 'placing' ? 0 : loaded;
  this._cctvSyncProgress.textContent =
    busy && catalogue.total == null
      ? `${format(catalogue.discovered)} camera records found`
      : `${format(placed)} / ${format(total)} cameras`;
}
