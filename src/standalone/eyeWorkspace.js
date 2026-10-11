import * as Cesium from 'cesium';
import { loadToolCatalog } from './toolCatalog.js';
import {
  GRAPHICS,
  applyGraphics,
  inRing,
  areaGeoJSON,
  recordsCSV,
  validArea,
} from './eyeModel.js';
import './eye.css';
import {
  createExtraPanels,
  createForecastPlayback,
  renderRecord,
} from './eyeExtras.js';

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const button = (text, run) => {
  const b = el('button', text);
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
};
const field = (parent, name, type = 'input') => {
  const label = el('label', name);
  const input = el(type);
  label.append(input);
  parent.append(label);
  return input;
};
const option = (s, value, text) => {
  const o = el('option', text);
  o.value = value;
  s.append(o);
};
const row = (...nodes) => {
  const r = el('div', null, 'eye-row');
  r.append(...nodes);
  return r;
};
const note = (text) => el('p', text, 'eye-muted');
async function json(path, init = {}) {
  const r = await fetch(path, {
    ...init,
    signal: init.signal || AbortSignal.timeout(45_000),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `Source answered ${r.status}`);
  return body;
}
function download(name, value, type = 'application/json') {
  const u = URL.createObjectURL(
    new Blob(
      [typeof value === 'string' ? value : JSON.stringify(value, null, 2)],
      { type },
    ),
  );
  const a = el('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function readSaved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private storage can be unavailable. */
  }
}

export function createEyeWorkspace({
  scene,
  controls,
  data,
  tools,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController } = scene;
  const cleanOptical = () =>
    controls.styleManager.applyVisualState({
      style: 'normal',
      scope: { enabled: false },
      bloom: { enabled: false },
      sharpen: { enabled: true, intensity: 25 },
      hud: { visible: false },
    });
  document.body.classList.add('eye-workspace');
  document.title = "Child's Eye";
  const brand = document.querySelector('#title-bar h1 > span:last-child');
  if (brand) brand.textContent = "CHILD'S EYE";
  const subtitle = document.querySelector('#title-bar .subtitle');
  if (subtitle) subtitle.textContent = 'LIVE DATA · LOCAL ANALYSIS';
  const panel = el('section');
  panel.id = 'eye-workspace';
  panel.hidden = true;
  panel.setAttribute('aria-label', "Child's Eye intelligence workspace");
  const launch = button('Workspace', () => toggle());
  launch.id = 'eye-launch';
  launch.setAttribute('aria-expanded', 'false');
  launch.setAttribute('aria-controls', panel.id);
  document.getElementById('top-center-actions')?.append(launch);
  const header = el('div', null, 'eye-header');
  const heading = el('div');
  heading.append(
    el('div', 'INTELLIGENCE WORKSPACE', 'eye-kicker'),
    el('h2', 'Intelligence desk'),
  );
  const close = button('Close', () => toggle(false));
  header.append(heading, close);
  const tabs = el('nav', null, 'eye-tabs');
  tabs.setAttribute('aria-label', 'Workspace sections');
  const body = el('div', null, 'eye-body');
  const status = el(
    'div',
    'Local workspace · AI Watch starts only when you ask',
    'eye-status',
  );
  status.setAttribute('role', 'status');
  panel.append(header, tabs, body, status);
  document.body.append(panel);
  let current = 'Overview';
  let tabCleanup = () => {};
  let generation = 0;
  let cameras = [];
  let news = [];
  let run = null;
  let eventSource = null;
  const extras = createExtraPanels({
    body,
    el,
    button,
    field,
    option,
    row,
    note,
    json,
    report: (...args) => report(...args),
    viewer,
    fly,
    data,
    show,
    reports,
    loadToolCatalog,
    defer,
    setCleanup: (cleanup) => {
      tabCleanup = cleanup;
    },
  });
  const panels = {
    Overview: overview,
    News: newsPanel,
    Broadcasts: extras.broadcastPanel,
    Conflicts: extras.conflictPanel,
    Cameras: cameraPanel,
    Areas: areaPanel,
    Investigate: investigationPanel,
    Forecast: forecastPanel,
    Assistant: extras.assistantPanel,
    Tools: toolsPanel,
  };
  const buttons = new Map();
  for (const name of Object.keys(panels)) {
    const b = button(name, () => show(name));
    buttons.set(name, b);
    tabs.append(b);
  }
  const report = (error) => {
    status.textContent = error?.message || String(error);
  };
  function toggle(value = panel.hidden) {
    panel.hidden = !value;
    launch.setAttribute('aria-expanded', String(value));
    if (value) show(current);
    else {
      generation++;
      tabCleanup();
      tabCleanup = () => {};
    }
  }
  async function show(name) {
    current = name;
    const turn = ++generation;
    tabCleanup();
    tabCleanup = () => {};
    body.replaceChildren();
    status.textContent = 'Local workspace · AI Watch starts only when you ask';
    panel.classList.toggle('eye-wide', name === 'Cameras');
    buttons.forEach((b, key) =>
      b.setAttribute('aria-selected', String(name === key)),
    );
    try {
      await panels[name](() => generation === turn && !signal.aborted);
    } catch (error) {
      if (turn === generation) report(error);
    }
  }
  async function catalogue() {
    let snapshot;
    do {
      snapshot = await json('/api/cctv/sources');
      cameras = snapshot.sources || [];
      if (!snapshot.coverage?.loading || snapshot.coverage.snapshotReady) break;
      const completed = snapshot.coverage.packs.filter(
        (p) => !['pending', 'loading'].includes(p.state),
      ).length;
      report(
        `Loading full camera inventories: ${completed}/${snapshot.coverage.packs.length} providers · ${cameras.length.toLocaleString()} cameras found`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (signal.aborted) return cameras;
    } while (true);
    if (snapshot.coverage) {
      const unavailable = snapshot.coverage.packs.filter((p) =>
        ['unavailable', 'stale', 'partial'].includes(p.state),
      ).length;
      report(
        `${cameras.length.toLocaleString()} cameras · ${unavailable} provider inventories unavailable or stale · no camera-count caps`,
      );
    }
    return cameras;
  }
  async function reports() {
    if (!news.length) news = (await json('/api/eye/news')).news || [];
    return news;
  }
  function fly(lon, lat, height = 1800) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.5,
    });
  }
  function overview() {
    body.append(
      el('h3', 'Globe quality'),
      note(
        'Sharper terrain and clean optical imagery. These presets adjust local rendering; they do not purchase map data.',
      ),
    );
    const quality = field(body, 'Graphics preset', 'select');
    for (const [id, p] of Object.entries(GRAPHICS))
      option(quality, id, `${p.label} · ${p.fps} fps target`);
    quality.value = readSaved('childs-eye.graphics', 'balanced');
    quality.addEventListener('change', () => {
      applyGraphics(viewer, tileset, quality.value);
      save('childs-eye.graphics', quality.value);
    });
    body.append(row(button('Use clean optical view', cleanOptical)));
    const imagery = el('div', null, 'eye-card');
    imagery.append(
      el('h3', 'Imagery & Street Level'),
      note(
        'The free starting view uses satellite imagery and terrain. Google photorealistic buildings require configured access and may incur provider charges. Street Level uses Mapillary photos, not live CCTV.',
      ),
    );
    imagery.append(
      button('Open map sources', () =>
        document.getElementById('control-panel-toggle')?.click(),
      ),
    );
    body.append(imagery);
    const watch = el('div', null, 'eye-card');
    watch.append(
      el('h3', 'Two ways to observe'),
      note(
        'Analyze a frame or watch one camera for 30 seconds in Cameras. Your area AI Watch keeps its local models, 20% GPU budget and notifications-only behavior.',
      ),
      button('Open AI Watch', () =>
        document.getElementById('ai-watch-toggle')?.click(),
      ),
    );
    body.append(
      watch,
      note(
        'FPS values are targets, not guarantees. High detail requests more terrain and tile detail. Monitoring limits rendering to 30 fps.',
      ),
    );
    const stats = el('p', '', 'eye-meta');
    body.append(stats);
    let frames = 0,
      since = performance.now();
    const off = viewer.scene.postRender.addEventListener(() => frames++);
    const timer = setInterval(() => {
      const now = performance.now();
      stats.textContent = `Rendered ${Math.round((frames * 1000) / (now - since))} fps · ${viewer.scene.canvas.width} × ${viewer.scene.canvas.height} · idle globe may intentionally stop rendering`;
      frames = 0;
      since = now;
    }, 1500);
    tabCleanup = () => {
      off();
      clearInterval(timer);
    };
  }
  async function newsPanel(active) {
    body.append(
      el('h3', 'News & public Telegram'),
      note(
        'Source reports, with their publication times. A place match is an approximate anchor, not a verified incident location.',
      ),
    );
    const search = field(body, 'Filter by topic or source');
    search.placeholder = 'Toronto, aviation, Ukraine…';
    const refresh = button('Refresh reports', async () => {
      news = [];
      await show('News');
    });
    body.append(row(refresh));
    const list = el('div');
    body.append(list);
    list.append(note('Fetching public feeds…'));
    const items = await reports();
    if (!active()) return;
    const render = () => {
      list.replaceChildren();
      const q = search.value.toLowerCase();
      const matches = items.filter((n) =>
        `${n.title} ${n.source_name || n.source || ''}`
          .toLowerCase()
          .includes(q),
      );
      status.textContent = `${matches.length} reports · source timestamps shown · refreshed ${new Date().toLocaleTimeString()}`;
      for (const n of matches.slice(0, 100)) {
        const card = el('article', null, 'eye-card');
        const link = n.link || n.url;
        const title = /^https?:\/\//.test(link || '')
          ? el('a', n.title)
          : el('strong', n.title);
        if (title.tagName === 'A') {
          title.href = link;
          title.target = '_blank';
          title.rel = 'noopener noreferrer';
        }
        const social = /t\.me\//.test(link || '');
        const date = Date.parse(n.published);
        card.append(
          title,
          el(
            'div',
            `${social ? 'Telegram · ' : ''}${n.source_name || n.source || 'Source not supplied'} · ${Number.isFinite(date) ? new Date(date).toLocaleString() : 'Publication time unavailable'}`,
            'eye-meta',
          ),
        );
        if (n.summary && n.summary !== n.title)
          card.append(note(n.summary.slice(0, 400)));
        const coords = n.place ? [n.place.lat, n.place.lng] : n.coords;
        if (coords?.every(Number.isFinite))
          card.append(
            button(
              `Show approximate area${n.coords_anchor ? ': ' + n.coords_anchor : ''}`,
              () => fly(coords[1], coords[0], 80000),
            ),
          );
        list.append(card);
      }
      if (!matches.length)
        list.append(
          note(
            'No reports match. Some sources may be unavailable; refresh to try again.',
          ),
        );
    };
    search.addEventListener('input', render);
    render();
  }
  async function cameraPanel(active) {
    body.append(
      el('h3', 'Camera desk'),
      note(
        'Up to four feeds at once. Close this section to stop playback and release streams. Local analysis counts visible objects; it does not identify people.',
      ),
    );
    const search = field(body, 'Find a camera');
    search.placeholder = 'City, provider or camera name';
    const filter = field(body, 'Feed type', 'select');
    option(filter, 'all', 'All cameras');
    option(filter, 'live', 'Live video');
    option(filter, 'still', 'Snapshots');
    option(filter, 'external', 'Embedded / operator website');
    const picker = field(body, 'Camera', 'select');
    const add = button('Add to desk', () => addCamera(picker.value));
    body.append(row(add));
    const grid = el('div', null, 'eye-camera-grid');
    body.append(grid);
    const open = new Map();
    let stopped = false;
    tabCleanup = () => {
      stopped = true;
      for (const dispose of open.values()) dispose();
      open.clear();
    };
    const sources = await catalogue();
    if (!active()) return;
    let page = 0;
    const previous = button('Previous cameras', () => {
      page = Math.max(0, page - 1);
      render();
    });
    const next = button('Next cameras', () => {
      page++;
      render();
    });
    body.insertBefore(
      row(
        previous,
        next,
        button('Export provider coverage', async () => {
          const snapshot = await json('/api/cctv/sources');
          download('camera-provider-coverage.json', snapshot.coverage);
        }),
      ),
      grid,
    );
    const render = () => {
      const q = search.value.toLowerCase();
      picker.replaceChildren();
      const found = sources.filter(
        (c) =>
          `${c.name} ${c.city} ${c.provider}`.toLowerCase().includes(q) &&
          (filter.value === 'all' ||
            (filter.value === 'live' &&
              ['hls', 'mp4', 'mjpeg'].includes(c.feedType)) ||
            (filter.value === 'still' && c.feedType === 'image') ||
            (filter.value === 'external' &&
              ['iframe', 'external'].includes(c.feedType))),
      );
      const pages = Math.max(1, Math.ceil(found.length / 250));
      page = Math.min(page, pages - 1);
      previous.disabled = page === 0;
      next.disabled = page >= pages - 1;
      for (const c of found.slice(page * 250, (page + 1) * 250))
        option(picker, c.id, `${c.city || c.provider} · ${c.name}`);
      status.textContent = `${found.length.toLocaleString()} matching registered cameras · page ${page + 1} of ${pages}. Availability varies.`;
    };
    search.addEventListener('input', render);
    filter.addEventListener('change', render);
    render();
    async function addCamera(id) {
      if (!id || open.has(id)) return;
      if (open.size >= 4)
        return report(
          'Four feeds are already open. Close one before adding another.',
        );
      const camera = sources.find((c) => c.id === id);
      if (!camera) return;
      const card = el('article', null, 'eye-camera');
      if (['iframe', 'external'].includes(camera.feedType)) {
        const footer = el('footer');
        footer.append(
          el('strong', camera.name),
          note(
            `${camera.provider} · ${camera.feedType === 'iframe' ? 'Embedded player' : 'Operator website'}. Local frame analysis is unavailable for this player.`,
          ),
        );
        if (camera.embedUrl) {
          const frame = el('iframe');
          frame.title = camera.name;
          frame.referrerPolicy = 'no-referrer';
          frame.sandbox = 'allow-scripts allow-same-origin allow-presentation';
          frame.allow = 'autoplay; fullscreen; picture-in-picture';
          frame.src = camera.embedUrl;
          card.append(frame);
        }
        const link = camera.externalUrl || camera.embedUrl;
        if (link) {
          const a = el('a', 'Open operator website');
          a.href = link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          footer.append(a);
        }
        const release = () => {
          card.querySelector('iframe')?.remove();
          card.remove();
        };
        open.set(id, release);
        footer.append(
          button('Locate', () => fly(camera.lon, camera.lat)),
          button('Close', () => {
            release();
            open.delete(id);
          }),
        );
        card.append(footer);
        grid.append(card);
        return;
      }
      const video = ['hls', 'mp4'].includes(camera.feedType);
      const media = el(video ? 'video' : 'img');
      const canvas = el('canvas');
      const footer = el('footer');
      const caption = el('div', 'Connecting…', 'eye-meta');
      const analysisCaption = el('div', null, 'eye-meta eye-analysis');
      const title = el('strong', camera.name);
      const lease = crypto.randomUUID();
      const mediaPath = `/api/cctv/media/${encodeURIComponent(id)}?lease=${lease}`;
      let hls,
        timer,
        objectUrl,
        disposed = false,
        watching = false,
        analysing = false;
      const controller = new AbortController();
      const release = () => {
        if (disposed) return;
        disposed = true;
        watching = false;
        clearTimeout(timer);
        controller.abort();
        hls?.destroy();
        if (video) {
          media.pause();
          media.removeAttribute('src');
          media.load();
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (camera.feedType === 'hls')
          fetch(mediaPath, { method: 'DELETE', keepalive: true }).catch(
            () => {},
          );
        card.remove();
      };
      open.set(id, release);
      const analyze = button('Analyze frame', () => analyse(false));
      const watch = button('Watch 30 s', () => analyse(true));
      footer.append(
        title,
        el(
          'div',
          `${camera.provider} · ${camera.feedType === 'image' ? 'Snapshot' : camera.feedType.toUpperCase()}`,
          'eye-meta',
        ),
        caption,
        analysisCaption,
        row(
          button('Locate', () => fly(camera.lon, camera.lat)),
          analyze,
          watch,
          button('Close', () => {
            release();
            open.delete(id);
          }),
        ),
      );
      card.append(media, canvas, footer);
      grid.append(card);
      async function snapshot() {
        try {
          const r = await fetch(`/api/cctv/frame/${encodeURIComponent(id)}`, {
            signal: controller.signal,
          });
          if (
            !r.ok ||
            /svg/.test(r.headers.get('content-type') || '') ||
            /street|fallback|synthetic/i.test(
              r.headers.get('x-cctv-source') || '',
            )
          )
            throw new Error('Camera unavailable; no live frame returned.');
          const blob = await r.blob();
          if (disposed) return;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(blob);
          media.src = objectUrl;
          caption.textContent = `Snapshot fetched ${new Date().toLocaleTimeString()}`;
        } catch (e) {
          if (!disposed) caption.textContent = e.message;
        }
        if (!disposed) timer = setTimeout(snapshot, 15000);
      }
      try {
        if (video) {
          media.muted = true;
          media.autoplay = true;
          media.controls = true;
          media.playsInline = true;
          if (camera.feedType === 'hls') {
            const { default: Hls } = await import('hls.js');
            if (disposed) return;
            if (Hls.isSupported()) {
              hls = new Hls({ maxBufferLength: 12 });
              hls.loadSource(mediaPath);
              hls.attachMedia(media);
              hls.on(Hls.Events.ERROR, (_, d) => {
                if (d.fatal) caption.textContent = 'Live stream unavailable.';
              });
            } else media.src = mediaPath;
          } else media.src = mediaPath;
          media.addEventListener('playing', () => {
            caption.textContent = 'Live video playing';
          });
          media.addEventListener('error', () => {
            caption.textContent = 'This feed could not be played.';
          });
        } else await snapshot();
      } catch (e) {
        caption.textContent = e.message;
      }
      async function analyse(watchMode) {
        if (analysing || disposed || stopped) return;
        analysing = true;
        watching = watchMode;
        analyze.disabled = true;
        watch.disabled = true;
        const samples = [];
        const start = performance.now();
        try {
          const { analyseBitmap, forgetSession } =
            await import('../../integrations/osiris/lib/vision/client.js');
          const { describeFrame, describeWatch, summariseWatch } =
            await import('../../integrations/osiris/lib/vision/analysis.js');
          forgetSession(id);
          do {
            analysisCaption.textContent = watchMode
              ? `Observing locally… ${Math.round((performance.now() - start) / 1000)} / 30 s`
              : 'Analyzing locally…';
            if (!video && !media.naturalWidth)
              throw new Error(
                'Wait for a real camera snapshot before analyzing.',
              );
            if (video && media.readyState < 2)
              throw new Error('Wait for the video to start before analyzing.');
            const image = await createImageBitmap(media);
            const a = await analyseBitmap(image, new Date().toISOString(), id);
            if (disposed || stopped) break;
            samples.push(a);
            canvas.width = a.width;
            canvas.height = a.height;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, a.width, a.height);
            ctx.strokeStyle = '#76eddf';
            ctx.fillStyle = '#76eddf';
            ctx.lineWidth = 2;
            ctx.font = `${Math.max(12, a.width / 60)}px sans-serif`;
            for (const d of a.detections) {
              ctx.strokeRect(...d.box);
              ctx.fillText(
                `${d.label} ${Math.round(d.score * 100)}%`,
                d.box[0],
                Math.max(14, d.box[1] - 5),
              );
            }
            analysisCaption.textContent = `${describeFrame(a)} · ${a.ms} ms inference · counts may miss objects`;
            if (!watchMode) break;
            await new Promise((resolve) => setTimeout(resolve, 2500));
          } while (
            watching &&
            !disposed &&
            !stopped &&
            performance.now() - start < 30000
          );
          if (watchMode && samples.length && !disposed && !stopped)
            analysisCaption.textContent = describeWatch(
              summariseWatch(
                samples,
                Math.round((performance.now() - start) / 1000),
              ),
            );
          forgetSession(id);
        } catch (e) {
          if (!disposed) analysisCaption.textContent = e.message;
        } finally {
          analysing = false;
          watching = false;
          analyze.disabled = false;
          watch.disabled = false;
        }
      }
    }
  }
  function areaPanel() {
    body.append(
      el('h3', 'Saved areas'),
      note(
        'Save the visible map boundary, or an area drawn with Display → Draw. Query registered cameras and loaded reports inside it.',
      ),
    );
    let areas = readSaved('childs-eye.areas', []).filter(validArea);
    const name = field(body, 'Area name');
    name.placeholder = 'Downtown Toronto';
    const list = el('div');
    const output = el('div');
    const persist = (area) => {
      if (!validArea(area)) throw new Error('The area needs a valid polygon.');
      areas.push(area);
      save('childs-eye.areas', areas);
      render();
    };
    body.append(
      row(
        button('Save current view', () => {
          const r = viewer.camera.computeViewRectangle();
          if (!r)
            return report('Move closer to the globe before saving this view.');
          const d = Cesium.Math.toDegrees;
          persist({
            name: name.value.trim() || 'Saved view',
            savedAt: new Date().toISOString(),
            ring: [
              [d(r.west), d(r.south)],
              [d(r.east), d(r.south)],
              [d(r.east), d(r.north)],
              [d(r.west), d(r.north)],
            ],
          });
        }),
        button('Save drawn area', () => {
          const a = tools.annotations
            .list()
            .filter((a) => a.type === 'area' && a.ring?.length >= 3)
            .at(-1);
          if (!a) return report('Draw an area with Display → Draw first.');
          persist({
            name: name.value.trim() || a.label || 'Drawn area',
            savedAt: new Date().toISOString(),
            ring: a.ring.map((p) => (Array.isArray(p) ? p : [p.lon, p.lat])),
          });
        }),
      ),
      list,
      output,
    );
    function render() {
      list.replaceChildren();
      for (const area of areas) {
        const card = el('div', null, 'eye-card');
        card.append(el('strong', area.name));
        card.append(
          row(
            button('Show', async () => {
              await tools.annotations.annotate(
                [
                  {
                    type: 'area',
                    manual: true,
                    ring: area.ring,
                    label: area.name,
                    persist: true,
                    color: 'cyan',
                  },
                ],
                { flyTo: true },
              );
            }),
            button('Query area', async () => {
              try {
                const [cs, ns] = await Promise.all([catalogue(), reports()]);
                const entities = [...data.dataManager.layers.values()].flatMap(
                  (layer) =>
                    (layer.module?.getAnalystRecords?.(2000) || []).map(
                      (r) => ({
                        kind: layer.id || 'entity',
                        id: r.id || r.icao24 || r.mmsi,
                        name: r.name || r.callsign || r.title || r.id,
                        provider: layer.name || layer.id,
                        lat: r.lat,
                        lon: r.lon ?? r.lng,
                      }),
                    ),
                );
                const records = [
                  ...cs.map((c) => ({ ...c, kind: 'camera' })),
                  ...ns.map((n) => ({
                    kind: 'report',
                    id: n.id,
                    name: n.title,
                    provider: n.source_name,
                    lat: n.place?.lat ?? n.coords?.[0],
                    lon: n.place?.lng ?? n.coords?.[1],
                    published: n.published,
                    url: n.link || n.url,
                  })),
                  ...entities,
                ].filter((r) => inRing(r.lon, r.lat, area.ring));
                output.replaceChildren(
                  el(
                    'h3',
                    `${records.length} cameras, reports and loaded entities in ${area.name}`,
                  ),
                  note(
                    'Report coordinates are approximate. Loaded entities are capped at 2,000 per layer; this is not proof of complete coverage.',
                  ),
                  row(
                    button('GeoJSON', () =>
                      download(
                        'childs-eye-area.geojson',
                        areaGeoJSON(area, records),
                      ),
                    ),
                    button('CSV', () =>
                      download(
                        'childs-eye-area.csv',
                        recordsCSV(records),
                        'text/csv',
                      ),
                    ),
                  ),
                );
                for (const r of records.slice(0, 100))
                  output.append(
                    note(`${r.kind} · ${r.name} · ${r.provider || ''}`),
                  );
              } catch (e) {
                report(e);
              }
            }),
            button('Export boundary', () =>
              download('childs-eye-area.geojson', areaGeoJSON(area)),
            ),
            button('Delete', () => {
              areas = areas.filter((a) => a !== area);
              save('childs-eye.areas', areas);
              render();
            }),
          ),
        );
        list.append(card);
      }
      if (!areas.length) list.append(note('No saved areas yet.'));
    }
    render();
  }
  function investigationPanel(active) {
    body.append(
      el('h3', 'Investigate public records'),
      note(
        'Queries public services. Results keep their source fields and timestamps. TCP checks run only when you select them and press Start TCP check.',
      ),
    );
    const kind = field(body, 'Record type', 'select');
    for (const [id, label] of Object.entries({
      dns: 'DNS records',
      whois: 'Domain registration (RDAP)',
      ip: 'IP information',
      certs: 'TLS certificate transparency',
      cve: 'Vulnerability (CVE)',
      crypto: 'Bitcoin / Ethereum wallet',
      sanctions: 'Sanctions records',
      scan: 'TCP ports and service banners',
    }))
      option(kind, id, label);
    const input = field(body, 'Domain, address, CVE ID or name');
    input.placeholder = 'example.com';
    const ports = field(body, 'TCP ports (comma separated; up to 32)');
    ports.value = '22,80,443,3389,8080';
    ports.parentElement.hidden = true;
    const output = el('div');
    let resultData;
    let request;
    kind.addEventListener('change', () => {
      ports.parentElement.hidden = kind.value !== 'scan';
      go.textContent = kind.value === 'scan' ? 'Start TCP check' : 'Look up';
    });
    tabCleanup = () => request?.abort();
    const go = button('Look up', async () => {
      go.disabled = true;
      output.textContent = 'Looking up public records…';
      try {
        request = new AbortController();
        if (kind.value === 'scan') {
          resultData = await json('/api/eye/scan', {
            method: 'POST',
            signal: request.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              host: input.value.trim(),
              ports: ports.value.split(',').map((p) => Number(p.trim())),
            }),
          });
        } else {
          const catalog = await loadToolCatalog();
          const result = await catalog.call(
            'eye_investigate',
            { kind: kind.value, query: input.value.trim() },
            { signal: request.signal },
          );
          resultData = result.data;
        }
        if (!active()) return;
        output.replaceChildren();
        renderRecord(output, resultData);
      } catch (e) {
        output.textContent = e.message;
      } finally {
        go.disabled = false;
      }
    });
    body.append(
      row(
        go,
        button('Stop', () => request?.abort()),
        button('Export result', () =>
          download('childs-eye-investigation.json', resultData || {}),
        ),
      ),
      output,
    );
  }
  async function forecastPanel(active) {
    body.append(
      el('h3', 'Research & scenarios'),
      note(
        'Optional cloud models. No request starts until you enter your own key and press Start. Scenarios cite sources but remain model-generated estimates.',
      ),
    );
    const config = await json('/api/eye/oi');
    if (!active()) return;
    const provider = field(body, 'Provider', 'select');
    for (const p of config.providers.filter((p) => p.id !== 'demo'))
      option(provider, p.id, p.name);
    const key = field(body, 'API key (used for this run only)');
    key.type = 'password';
    key.autocomplete = 'off';
    const model = field(body, 'Model');
    const setModel = () => {
      model.value =
        config.providers.find((p) => p.id === provider.value)?.default_model ||
        '';
    };
    provider.addEventListener('change', setModel);
    setModel();
    const question = field(body, 'Research question', 'textarea');
    question.placeholder =
      'What could change traffic disruption in this area over the next week?';
    const seed = field(
      body,
      'Your context (paste text, CSV, JSON or Markdown)',
      'textarea',
    );
    seed.maxLength = 100000;
    const file = field(body, 'Load context file');
    file.type = 'file';
    file.accept = '.txt,.csv,.json,.md,.log,.html';
    file.addEventListener('change', async () => {
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 400000)
        return report('Use a text file under 400 KB and 100,000 characters.');
      const text = await selected.text();
      if (text.length > 100000)
        return report(
          'Context exceeds 100,000 characters. Shorten it before loading.',
        );
      if (active()) {
        seed.value = text;
        estimateText();
      }
    });
    const scope = field(body, 'Context use', 'select');
    option(scope, 'brief', 'Read once when building the world');
    option(
      scope,
      'panel',
      'Also show the first 8,000 characters to actors each period',
    );
    const depth = field(body, 'Depth', 'select');
    for (const d of config.depths)
      option(depth, d.id, `${d.id} · about ${d.model_calls} model calls`);
    depth.value = 'quick';
    const estimate = note('');
    const estimateText = () => {
      const d = config.depths.find((d) => d.id === depth.value);
      estimate.textContent = `Estimated ${d?.model_calls} model calls, plus public-source research. Token usage and dollar cost depend on your provider, model and response lengths. This is not a dollar quote. One run at a time; cancel stops future work but cannot undo billed calls.`;
      const settings = {
        quick: [4, 3, 2],
        standard: [6, 4, 3],
        deep: [7, 4, 4],
      }[depth.value];
      const reads =
        scope.value === 'panel' ? settings.reduce((a, b) => a * b, 1) + 1 : 0;
      estimate.textContent += ` Your context adds approximately ${Math.ceil(seed.value.length / 4) + Math.ceil(Math.min(seed.value.length, 8000) / 4) * reads} input tokens before retries.`;
    };
    depth.addEventListener('change', estimateText);
    seed.addEventListener('input', estimateText);
    scope.addEventListener('change', estimateText);
    estimateText();
    body.append(estimate);
    const progress = el('pre');
    const output = el('div');
    const playbackBox = el('section');
    const playback = createForecastPlayback({
      parent: playbackBox,
      viewer,
      fly,
      el,
      field,
      option,
      button,
      row,
      note,
    });
    const steering = field(
      body,
      'Event to inject or follow-up question',
      'textarea',
    );
    const answer = el('div');
    const runRequest = async (operation) => {
      const currentRun = run || readSaved('childs-eye.last-run', null);
      if (!currentRun?.id || !steering.value.trim())
        return report('Choose a run and enter a message.');
      try {
        const result = await json(
          `/api/eye/oi/runs/${currentRun.id}/${operation}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-OI-Run-Token': currentRun.run_token || currentRun.token,
              'X-OI-Key': key.value.trim(),
              'X-OI-Provider': provider.value,
              'X-OI-Model': model.value.trim(),
            },
            body: JSON.stringify(
              operation === 'inject'
                ? { text: steering.value }
                : { target: 'report', message: steering.value },
            ),
          },
        );
        if (active()) {
          answer.replaceChildren();
          renderRecord(answer, result);
        }
      } catch (e) {
        report(e);
      }
    };
    body.append(
      row(
        button('Inject into next period', () => runRequest('inject')),
        button('Ask about run (uses entered key)', () => runRequest('ask')),
      ),
      answer,
    );
    const start = button('Start research', async () => {
      if (!key.value.trim() || question.value.trim().length < 8)
        return report('Enter a provider key and a research question first.');
      start.disabled = true;
      try {
        const result = await json('/api/eye/oi/runs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-OI-Key': key.value.trim(),
            'X-OI-Provider': provider.value,
            'X-OI-Model': model.value.trim(),
          },
          body: JSON.stringify({
            question: question.value,
            depth: depth.value,
            seed: seed.value,
            seed_scope: scope.value,
            use_feeds: true,
          }),
        });
        key.value = '';
        run = result;
        save('childs-eye.last-run', { id: result.id, token: result.run_token });
        if (active()) attach(result.id);
      } catch (e) {
        report(e);
        start.disabled = false;
      }
    });
    start.className = 'eye-primary';
    const cancel = button('Cancel run', async () => {
      const r = run || readSaved('childs-eye.last-run', null);
      if (!r?.id) return report('No run to cancel.');
      try {
        await json(`/api/eye/oi/runs/${r.id}`, {
          method: 'DELETE',
          headers: { 'X-OI-Run-Token': r.run_token || r.token },
        });
        report('Cancellation requested.');
      } catch (e) {
        report(e);
      }
    });
    body.append(
      row(
        start,
        cancel,
        button('Export report', async () => {
          const id = run?.id || readSaved('childs-eye.last-run', {})?.id;
          if (!id) return report('No report yet.');
          try {
            download(
              'childs-eye-research.json',
              await json(`/api/eye/oi/runs/${id}`),
            );
          } catch (e) {
            report(e);
          }
        }),
      ),
      progress,
      playbackBox,
      output,
    );
    function attach(id) {
      eventSource?.close();
      progress.textContent = 'Connecting to research progress…';
      eventSource = new EventSource(`/api/eye/oi/runs/${id}/events`);
      const lines = [];
      const receive = async (e) => {
        try {
          const data = JSON.parse(e.data);
          const line =
            data.label ||
            data.message ||
            (data.t === 'thinking'
              ? `${data.actor} · considering ${data.world}`
              : data.t === 'usage'
                ? `${data.usage.calls} model calls · ${data.usage.input + data.usage.output} tokens`
                : data.t === 'end'
                  ? `Run ${data.status}`
                  : null);
          if (line) lines.push(line);
          progress.textContent = lines.slice(-20).join('\n');
          progress.scrollTop = progress.scrollHeight;
        } catch {
          /* keepalive */
        }
      };
      eventSource.onmessage = receive;
      for (const event of [
        'progress',
        'context',
        'plan',
        'cast',
        'step',
        'world',
        'report',
        'done',
        'error',
        'event',
      ])
        eventSource.addEventListener(event, receive);
      let polling = false;
      const poll = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const result = await json(`/api/eye/oi/runs/${id}`);
          if (!active()) return;
          playback.update(result.worlds);
          output.replaceChildren(
            el('h3', result.phase_label || result.status),
            note(
              `${result.usage?.calls || 0} model calls · ${result.usage?.input || 0} input / ${result.usage?.output || 0} output tokens`,
            ),
          );
          const reportBody = result.report;
          if (reportBody) {
            const card = el('article', null, 'eye-card');
            card.append(
              el('h3', reportBody.headline),
              el('p', reportBody.answer, 'eye-stat'),
              note(
                `Model confidence: ${reportBody.confidence} · scenario estimate`,
              ),
              el('p', reportBody.summary),
            );
            for (const scenario of reportBody.scenarios || [])
              card.append(
                el('h3', scenario.name || scenario.title || 'Scenario'),
                note(
                  scenario.summary ||
                    scenario.description ||
                    scenario.story ||
                    '',
                ),
              );
            if (reportBody.dissent)
              card.append(el('h3', 'Disagreement'), note(reportBody.dissent));
            for (const caveat of reportBody.caveats || [])
              card.append(note(caveat));
            output.append(card);
          }
          if (result.sources?.length)
            output.append(el('h3', 'Evidence and sources'));
          for (const source of result.sources || []) {
            const card = el('article', null, 'eye-card');
            const title = el('a', `[${source.id}] ${source.title}`);
            if (/^https?:\/\//.test(source.url || '')) {
              title.href = source.url;
              title.target = '_blank';
              title.rel = 'noopener noreferrer';
            }
            card.append(
              title,
              note(
                `${source.source} · ${source.published || 'Date unavailable'}`,
              ),
            );
            if (source.excerpt) card.append(note(source.excerpt));
            output.append(card);
          }
          if (result.message) output.append(note(result.message));
          if (result.status && result.status !== 'running') {
            start.disabled = false;
            eventSource?.close();
            clearInterval(poll);
          }
        } catch (e) {
          report(e);
          eventSource?.close();
          clearInterval(poll);
          start.disabled = false;
        } finally {
          polling = false;
        }
      }, 4000);
      tabCleanup = () => {
        eventSource?.close();
        eventSource = null;
        clearInterval(poll);
        key.value = '';
        playback.dispose();
      };
    }
    const saved = run || readSaved('childs-eye.last-run', null);
    if (saved?.id) attach(saved.id);
    else
      tabCleanup = () => {
        key.value = '';
        playback.dispose();
      };
  }
  async function toolsPanel(active) {
    body.append(
      el('h3', 'Shared tools'),
      note(
        'Search live data or look up public records. Choose a tool and enter its inputs below.',
      ),
    );
    const catalog = await loadToolCatalog();
    if (!active()) return;
    const choice = field(body, 'Tool', 'select');
    for (const t of catalog.list().filter((t) => t.kind === 'query'))
      option(choice, t.name, t.title);
    const description = note('');
    const args = field(body, 'Arguments (JSON)', 'textarea');
    const schema = el('details');
    schema.append(el('summary', 'Argument schema'));
    const spec = el('pre');
    schema.append(spec);
    const update = () => {
      const t = catalog.get(choice.value);
      description.textContent = t.description;
      args.value = '{}';
      spec.textContent = JSON.stringify(t.inputSchema, null, 2);
    };
    choice.addEventListener('change', update);
    update();
    const output = el('pre');
    const go = button('Run tool', async () => {
      go.disabled = true;
      try {
        output.textContent = 'Working…';
        const result = await catalog.call(
          choice.value,
          JSON.parse(args.value),
          { signal },
        );
        output.textContent =
          result.summary + '\n\n' + JSON.stringify(result.data, null, 2);
      } catch (e) {
        output.textContent = e.message;
      } finally {
        go.disabled = false;
      }
    });
    body.append(description, schema, row(go), output);
  }
  applyGraphics(viewer, tileset, readSaved('childs-eye.graphics', 'balanced'));
  Promise.resolve(controls.styleManager.initialRestorePromise).then(() => {
    if (signal.aborted || readSaved('childs-eye.optical-initialized', false))
      return;
    // First upgrade uses the requested clean optical default; future choices persist.
    if (!location.search && !location.hash) cleanOptical();
    save('childs-eye.optical-initialized', true);
  });
  const escape = (e) => {
    if (e.key === 'Escape' && !panel.hidden) toggle(false);
  };
  panel.addEventListener('keydown', escape);
  defer(() => {
    generation++;
    tabCleanup();
    eventSource?.close();
    panel.remove();
    launch.remove();
    document.body.classList.remove('eye-workspace');
  });
  return {
    open: (name) => {
      panel.hidden = false;
      launch.setAttribute('aria-expanded', 'true');
      show(name || current);
    },
    close: () => toggle(false),
  };
}
