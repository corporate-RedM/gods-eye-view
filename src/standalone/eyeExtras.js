import * as Cesium from 'cesium';
import { broadcasts, conflictZones } from './eyeSources.js';

export function createForecastPlayback({
  parent,
  viewer,
  fly,
  el,
  field,
  option,
  button,
  row,
  note,
}) {
  parent.append(
    el('h3', 'Simulated worlds'),
    note(
      'Playback shows model-generated scenario events, not live observations. Events without coordinates stay in the timeline.',
    ),
  );
  const world = field(parent, 'World', 'select');
  const step = field(parent, 'Event');
  step.type = 'range';
  step.min = '0';
  step.max = '0';
  step.value = '0';
  const summary = el('article', null, 'eye-card');
  const layer = new Cesium.CustomDataSource('Simulated forecast');
  let worlds = [],
    timer,
    disposed = false;
  viewer.dataSources.add(layer).then(() => {
    if (disposed) viewer.dataSources.remove(layer, true);
  });
  const events = () =>
    worlds.find((w) => w.world === world.value)?.events || [];
  const render = (move = false) => {
    const items = events();
    step.max = String(Math.max(0, items.length - 1));
    const index = Math.min(Number(step.value), items.length - 1);
    const event = items[index];
    layer.entities.removeAll();
    summary.replaceChildren();
    if (!event) {
      summary.append(note('No simulated events yet.'));
      return;
    }
    summary.append(
      el('h3', event.title),
      note(
        `${event.date || ''} · ${event.place || 'Location unavailable'} · SIMULATED`,
      ),
      el('p', event.detail || ''),
    );
    if (
      Number.isFinite(event.lat) &&
      Number.isFinite(event.lng) &&
      Math.abs(event.lat) <= 90 &&
      Math.abs(event.lng) <= 180
    ) {
      layer.entities.add({
        name: `SIMULATED: ${event.title}`,
        position: Cesium.Cartesian3.fromDegrees(event.lng, event.lat),
        point: {
          pixelSize: 14,
          color: Cesium.Color.ORANGE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Infinity,
        },
      });
      if (move) fly(event.lng, event.lat, 400000);
    }
    viewer.scene.requestRender();
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  world.addEventListener('change', () => {
    stop();
    step.value = '0';
    render();
  });
  step.addEventListener('input', () => {
    stop();
    render(true);
  });
  parent.append(
    row(
      button('Play scenario', () => {
        stop();
        render(true);
        timer = setInterval(() => {
          if (Number(step.value) >= events().length - 1) return stop();
          step.value = String(Number(step.value) + 1);
          render(true);
        }, 3500);
      }),
      button('Pause', stop),
      button('Show event', () => render(true)),
    ),
    summary,
  );
  return {
    update(next) {
      const selected = world.value;
      worlds = next || [];
      world.replaceChildren();
      for (const w of worlds)
        option(world, w.world, `World ${w.world} · ${w.events.length} events`);
      if (worlds.some((w) => w.world === selected)) world.value = selected;
      render();
    },
    dispose() {
      disposed = true;
      stop();
      viewer.dataSources.remove(layer, true);
      viewer.scene.requestRender();
    },
  };
}

export function renderRecord(parent, value, label = 'Result', depth = 0) {
  const make = (tag, text) => {
    const n = document.createElement(tag);
    n.textContent = text;
    return n;
  };
  if (value == null || typeof value !== 'object') {
    const line = make('p', `${label}: ${value ?? 'Unavailable'}`);
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      const link = make('a', value);
      link.href = value;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.replaceChildren(make('span', `${label}: `), link);
    }
    parent.append(line);
    return;
  }
  const section = make('details', '');
  section.open = depth < 2;
  section.append(
    make(
      'summary',
      `${label}${Array.isArray(value) ? ` · ${value.length} records` : ''}`,
    ),
  );
  parent.append(section);
  for (const [key, child] of Object.entries(value)) {
    if (depth < 6)
      renderRecord(
        section,
        child,
        Array.isArray(value)
          ? `Record ${Number(key) + 1}`
          : key.replaceAll('_', ' '),
        depth + 1,
      );
    else section.append(make('pre', JSON.stringify(child, null, 2)));
  }
}

export function createExtraPanels({
  body,
  el,
  button,
  field,
  option,
  row,
  note,
  json,
  report,
  viewer,
  fly,
  data,
  show,
  reports,
  loadToolCatalog,
  setCleanup,
  defer,
}) {
  const overlays = new Map();
  defer(() => {
    for (const entry of overlays.values())
      viewer.dataSources.remove(entry.layer, true);
    overlays.clear();
  });
  function overlay(name, points, color) {
    const existing = overlays.get(name);
    if (existing) {
      const pin = field(body, `Keep ${name.toLowerCase()} on globe`);
      pin.type = 'checkbox';
      pin.checked = existing.pinned;
      pin.addEventListener('change', () => {
        existing.pinned = pin.checked;
      });
      return () => {
        if (!existing.pinned) {
          viewer.dataSources.remove(existing.layer, true);
          overlays.delete(name);
        }
      };
    }
    const layer = new Cesium.CustomDataSource(name);
    const entry = { layer, pinned: false };
    overlays.set(name, entry);
    const pin = field(body, `Keep ${name.toLowerCase()} on globe`);
    pin.type = 'checkbox';
    pin.addEventListener('change', () => {
      entry.pinned = pin.checked;
    });
    for (const p of points)
      layer.entities.add({
        id: `${name}-${p.id || p.name}`,
        name: p.label || p.name,
        position: Cesium.Cartesian3.fromDegrees(p.lng, p.lat),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Infinity,
        },
      });
    let disposed = false;
    viewer.dataSources.add(layer).then(() => {
      if (disposed) viewer.dataSources.remove(layer, true);
    });
    viewer.scene.requestRender();
    return () => {
      if (entry.pinned) return;
      disposed = true;
      viewer.dataSources.remove(layer, true);
      overlays.delete(name);
      viewer.scene.requestRender();
    };
  }
  function broadcastPanel() {
    body.append(
      el('h3', 'Live broadcasts'),
      note(
        '23 channels from Osiris. Locations identify the newsroom. Each channel has an external link if its player is restricted.',
      ),
    );
    const remove = overlay('Broadcasts', broadcasts, '#64d7ed');
    const search = field(body, 'Find channel or region');
    const list = el('div', null, 'eye-grid');
    const player = el('div');
    body.append(player, list);
    function draw() {
      list.replaceChildren();
      for (const feed of broadcasts.filter((f) =>
        `${f.name} ${f.city} ${f.region}`
          .toLowerCase()
          .includes(search.value.toLowerCase()),
      )) {
        const card = el('article', null, 'eye-card');
        const link = el('a', 'Open broadcaster');
        const url = new URL(feed.url);
        link.href = `https://www.youtube.com/channel/${url.searchParams.get('channel')}/live`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.append(
          el('h3', feed.name),
          note(`${feed.city} · ${feed.category}`),
          row(
            button('Watch', () => {
              const frame = el('iframe');
              frame.src = feed.url;
              frame.title = feed.name;
              frame.allow = 'fullscreen; encrypted-media';
              frame.referrerPolicy = 'strict-origin-when-cross-origin';
              frame.style.cssText = 'width:100%;height:360px;border:0';
              player.replaceChildren(
                el('h3', feed.name),
                button('Stop player', () => player.replaceChildren()),
                frame,
              );
            }),
            button('Show newsroom', () => fly(feed.lng, feed.lat, 30000)),
            link,
          ),
        );
        list.append(card);
      }
    }
    search.addEventListener('input', draw);
    draw();
    setCleanup(() => {
      player.replaceChildren();
      remove();
    });
  }
  async function conflictPanel(active) {
    body.append(
      el('h3', 'Conflict-zone watch'),
      note(
        '15 editorial areas from the pinned Osiris source. Severity is the source’s classification, not a live assessment. Matched headlines are located at the region level; they are not exact event coordinates.',
      ),
    );
    const remove = overlay('Conflict zones', conflictZones, '#f0a36e');
    setCleanup(remove);
    const list = el('div', null, 'eye-grid');
    body.append(list);
    const news = await reports();
    if (!active()) return;
    for (const zone of conflictZones) {
      const card = el('article', null, 'eye-card');
      const matched = news.filter((n) => {
        const text = `${n.title} ${n.summary || ''}`.toLowerCase();
        return (
          zone.queries.some((q) =>
            q.split(' ').every((term) => text.includes(term)),
          ) || text.includes(zone.region)
        );
      });
      card.append(
        el('h3', zone.label),
        note(`${zone.severity} · ${matched.length} matching reports`),
        button('Show region', () => fly(zone.lng, zone.lat, 700000)),
      );
      const source = el('a', 'Regional source');
      source.href = zone.sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      card.append(source);
      for (const item of matched.slice(0, 15)) {
        const link = el('a', item.title);
        const url = item.url || item.link;
        if (/^https?:\/\//.test(url || '')) {
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        const p = el('p');
        p.append(
          link,
          note(
            item.published || item.timestamp || item.date || 'Date unavailable',
          ),
        );
        card.append(p);
      }
      list.append(card);
    }
  }
  async function assistantPanel(active) {
    body.append(
      el('h3', 'Ask Child’s Eye'),
      note(
        'Ask about live data, move the globe, switch layers or open a workspace. Uses your selected model and key; up to six model steps per message.',
      ),
    );
    const config = await json('/api/eye/oi');
    const catalog = await loadToolCatalog();
    if (!active()) return;
    const provider = field(body, 'Provider', 'select');
    for (const p of config.providers) option(provider, p.id, p.name);
    const key = field(body, 'API key (memory only)');
    key.type = 'password';
    key.autocomplete = 'off';
    const model = field(body, 'Model');
    const update = () => {
      model.value =
        config.providers.find((p) => p.id === provider.value)?.default_model ||
        '';
    };
    provider.addEventListener('change', update);
    update();
    const transcript = el('div', null, 'eye-chat');
    body.append(transcript);
    const input = field(body, 'Message', 'textarea');
    const messages = [];
    let controller;
    const add = (who, text) => {
      const p = el('article', null, 'eye-card');
      p.append(el('strong', who), el('p', text));
      transcript.append(p);
    };
    const schema = (properties) => ({
      type: 'object',
      properties,
      additionalProperties: false,
    });
    const definitions = catalog
      .list()
      .filter((t) => t.kind === 'query')
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }));
    definitions.push(
      {
        name: 'move_globe',
        description: 'Move the globe to longitude/latitude in degrees.',
        inputSchema: schema({
          lon: { type: 'number' },
          lat: { type: 'number' },
          height: { type: 'number' },
        }),
      },
      {
        name: 'set_map_layer',
        description: 'Enable or disable one of the layers named in context.',
        inputSchema: schema({
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        }),
      },
      {
        name: 'open_workspace',
        description:
          'Open a workspace tab. Forecast opens settings but does not start a paid run.',
        inputSchema: schema({
          name: {
            type: 'string',
            enum: [
              'News',
              'Cameras',
              'Areas',
              'Investigate',
              'Forecast',
              'Broadcasts',
              'Conflicts',
            ],
          },
        }),
      },
    );
    async function action(a) {
      if (a.name === 'move_globe') {
        const { lon, lat, height = 20000 } = a.args;
        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          Math.abs(lon) > 180 ||
          Math.abs(lat) > 90 ||
          !Number.isFinite(height) ||
          height < 100 ||
          height > 30000000
        )
          throw new Error('Invalid globe coordinates.');
        fly(lon, lat, height);
        return { movedTo: { lon, lat, height } };
      }
      if (a.name === 'set_map_layer') {
        const { id, enabled } = a.args;
        if (
          !data.dataManager.layers.has(id) ||
          typeof enabled !== 'boolean' ||
          /watch|detect/i.test(id)
        )
          throw new Error('Unavailable map layer.');
        await data.dataManager.setEnabled(id, enabled, { origin: 'user' });
        return { id, enabled };
      }
      if (a.name === 'open_workspace') {
        if (
          !definitions
            .at(-1)
            .inputSchema.properties.name.enum.includes(a.args.name)
        )
          throw new Error('Unknown workspace.');
        await show(a.args.name);
        return { opened: a.args.name };
      }
      if (
        !definitions.some((t) => t.name === a.name) ||
        catalog.get(a.name)?.kind !== 'query'
      )
        throw new Error('Unknown tool.');
      return catalog.call(a.name, a.args, { signal: controller.signal });
    }
    const send = button('Send', async () => {
      if (!input.value.trim() || !key.value.trim())
        return report('Enter a key and message.');
      const text = input.value.trim();
      input.value = '';
      add('You', text);
      messages.push({ role: 'user', text });
      send.disabled = true;
      controller = new AbortController();
      try {
        for (let step = 0; step < 6 && active(); step++) {
          const carto = viewer.camera.positionCartographic;
          const result = await json('/api/eye/assistant', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'X-OI-Key': key.value.trim(),
              'X-OI-Provider': provider.value,
              'X-OI-Model': model.value,
            },
            body: JSON.stringify({
              messages: messages.slice(-24),
              tools: definitions,
              context: {
                view: {
                  lat: Cesium.Math.toDegrees(carto.latitude),
                  lon: Cesium.Math.toDegrees(carto.longitude),
                },
                layers: [...data.dataManager.layers.keys()],
              },
            }),
          });
          if (!active()) return;
          if (result.say) add('Child’s Eye', result.say);
          messages.push({ role: 'assistant', text: result.say });
          for (const a of result.actions) {
            if (!active() || controller.signal.aborted) return;
            try {
              const result = await action(a);
              const content = JSON.stringify(result);
              messages.push({
                role: 'tool',
                name: a.name,
                result: content.slice(0, 12000),
              });
              if (active())
                add(
                  a.name,
                  result.summary || JSON.stringify(result).slice(0, 500),
                );
            } catch (e) {
              messages.push({ role: 'tool', name: a.name, error: e.message });
              add(a.name, e.message);
            }
          }
          if (result.done || !result.actions.length) break;
          if (step === 5)
            add(
              'Child’s Eye',
              'Step limit reached. Send another message to continue.',
            );
        }
      } catch (e) {
        if (active())
          add(
            'Child’s Eye',
            controller.signal.aborted ? 'Stopped.' : e.message,
          );
      } finally {
        send.disabled = false;
      }
    });
    body.append(
      row(
        send,
        button('Stop', () => controller?.abort()),
        button('Clear conversation', () => {
          controller?.abort();
          messages.length = 0;
          transcript.replaceChildren();
        }),
      ),
    );
    setCleanup(() => {
      controller?.abort();
      key.value = '';
      messages.length = 0;
    });
  }
  return { broadcastPanel, conflictPanel, assistantPanel };
}
