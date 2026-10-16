const ROW_HEIGHT = 68;

export function cameraPickerLabel(camera) {
  let name = String(
    camera.name || camera.code || camera.id || 'Unnamed camera',
  );
  const repeated = name.split(/\s+[—–]\s+/);
  if (repeated.length > 1 && repeated.every((part) => part === repeated[0]))
    name = repeated[0];
  const place = [camera.city, camera.provider].filter(Boolean).join(' · ');
  const availability = camera.liveFailed
    ? 'Temporarily unavailable'
    : {
        available: 'Playback checked',
        unavailable: 'Temporarily unavailable',
        unverified: 'Playback unverified',
        unchecked: 'Not checked yet',
      }[camera.playback?.status] || 'Not checked yet';
  return {
    name,
    details: [
      place,
      String(camera.feedType || 'video').toUpperCase(),
      availability,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

export function filterCameraPickerRows(cameras, query) {
  const words = String(query || '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return cameras;
  return cameras.filter((camera) => {
    const text =
      `${camera.name} ${camera.originalName || ''} ${camera.city} ${camera.originalCity || ''} ${camera.provider} ${camera.id} ${camera.code || ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Full-catalogue combobox. Scroll height represents every match; DOM stays small. */
export function createCameraCataloguePicker(controls) {
  const input = controls._cctvSearch;
  if (!input?.setAttribute || !document.body?.appendChild) return null;
  const popup = document.createElement('div');
  popup.className = 'cctv-catalogue-picker';
  popup.hidden = true;
  const heading = document.createElement('div');
  heading.className = 'cctv-catalogue-picker-count';
  heading.setAttribute('aria-live', 'polite');
  const viewport = document.createElement('div');
  viewport.className = 'cctv-catalogue-picker-viewport';
  viewport.id = 'cctv-catalogue-results';
  viewport.setAttribute('role', 'listbox');
  viewport.setAttribute('aria-label', 'Complete camera catalogue');
  const space = document.createElement('div');
  space.className = 'cctv-catalogue-picker-space';
  viewport.appendChild(space);
  popup.append(heading, viewport);
  document.body.appendChild(popup);
  input.removeAttribute('list');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', viewport.id);
  input.setAttribute('aria-expanded', 'false');
  let cameras = [],
    matches = [],
    selected = -1,
    query = '',
    open = false;
  let searchTimer;
  const close = () => {
    open = false;
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const place = () => {
    if (!open) return;
    const bounds = input.getBoundingClientRect();
    const width = Math.min(Math.max(bounds.width, 480), window.innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
    const below = window.innerHeight - bounds.bottom - 16;
    const height = Math.min(360, Math.max(below, bounds.top - 16));
    viewport.style.maxHeight = `${Math.max(100, height - 40)}px`;
    popup.style.top = `${below >= height ? bounds.bottom + 4 : Math.max(8, bounds.top - height - 4)}px`;
  };
  const choose = (camera) => {
    if (!camera) return;
    const select = controls._cctvSelect;
    if (![...select.options].some((option) => option.value === camera.id)) {
      const option = document.createElement('option');
      option.value = camera.id;
      option.textContent = `${camera.city} · ${camera.name}`;
      select.appendChild(option);
    }
    select.value = camera.id;
    close();
    input.value = '';
    select.dispatchEvent(new Event('change'));
  };
  const render = () => {
    if (!open) return;
    const kind = query ? 'matches' : 'cameras';
    heading.textContent = `${matches.length.toLocaleString()} ${kind} · Scroll to browse all`;
    space.style.height = `${matches.length * ROW_HEIGHT}px`;
    const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 3);
    const end = Math.min(
      matches.length,
      start + Math.ceil((viewport.clientHeight || 320) / ROW_HEIGHT) + 7,
    );
    space.replaceChildren();
    for (let i = start; i < end; i++) {
      const camera = matches[i],
        label = cameraPickerLabel(camera);
      const row = document.createElement('div');
      row.className = 'cctv-catalogue-picker-row';
      row.style.top = `${i * ROW_HEIGHT}px`;
      row.id = `cctv-catalogue-row-${i}`;
      row.dataset.cameraId = camera.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === selected));
      row.setAttribute('aria-posinset', String(i + 1));
      row.setAttribute('aria-setsize', String(matches.length));
      row.title = `${label.name}\n${label.details}\n${camera.id}`;
      const name = document.createElement('strong');
      name.textContent = label.name;
      const details = document.createElement('span');
      details.textContent = label.details;
      row.append(name, details);
      row.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        choose(camera);
      });
      space.appendChild(row);
    }
    if (selected >= start && selected < end)
      input.setAttribute(
        'aria-activedescendant',
        `cctv-catalogue-row-${selected}`,
      );
    else input.removeAttribute('aria-activedescendant');
  };
  const filter = () => {
    query = input.value.trim();
    matches = filterCameraPickerRows(cameras, query);
    selected = -1;
    viewport.scrollTop = 0;
    render();
  };
  const show = () => {
    if (input.disabled || controls.destroyed) return;
    open = true;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    place();
    filter();
  };
  controls.listen(input, 'focus', show);
  controls.listen(controls._cctvSelect, 'pointerdown', (event) => {
    if (controls._cctvSelect.disabled) return;
    event.preventDefault();
    input.focus();
    show();
  });
  controls.listen(controls._cctvSelect, 'keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    input.focus();
    show();
  });
  controls.listen(input, 'click', () => {
    if (!open) show();
  });
  controls.listen(input, 'input', () => {
    clearTimeout(searchTimer);
    if (!open) show();
    searchTimer = setTimeout(filter, 100);
  });
  controls.listen(input, 'keydown', (event) => {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (
      ![
        'ArrowDown',
        'ArrowUp',
        'Home',
        'End',
        'PageDown',
        'PageUp',
        'Enter',
      ].includes(event.key)
    )
      return;
    if (!open && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(searchTimer);
    if (!open) show();
    if (query !== input.value.trim()) filter();
    if (event.key === 'Enter') {
      choose(matches[selected >= 0 ? selected : 0]);
      return;
    }
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 };
    selected =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? matches.length - 1
          : Math.max(
              0,
              Math.min(matches.length - 1, selected + steps[event.key]),
            );
    if (selected * ROW_HEIGHT < viewport.scrollTop)
      viewport.scrollTop = selected * ROW_HEIGHT;
    else if (
      (selected + 1) * ROW_HEIGHT >
      viewport.scrollTop + viewport.clientHeight
    )
      viewport.scrollTop = (selected + 1) * ROW_HEIGHT - viewport.clientHeight;
    render();
  });
  controls.listen(viewport, 'scroll', render);
  controls.listen(document, 'pointerdown', (event) => {
    if (
      event.target !== input &&
      event.target !== controls._cctvSelect &&
      !popup.contains(event.target)
    )
      close();
  });
  // Clicking the scroll bar may blur the input. Keep the complete list open
  // while browsing it; close only when focus actually moves outside it.
  controls.listen(document, 'focusin', (event) => {
    if (
      event.target !== input &&
      event.target !== controls._cctvSelect &&
      !popup.contains(event.target)
    )
      close();
  });
  controls.listen(window, 'resize', place);
  return {
    setCameras(next) {
      const selectedId = matches[selected]?.id;
      cameras = next;
      if (open) {
        // Stream-status notifications must not jump a user back to row one.
        query = input.value.trim();
        matches = filterCameraPickerRows(cameras, query);
        selected = selectedId
          ? matches.findIndex((camera) => camera.id === selectedId)
          : -1;
        render();
      }
    },
    close,
    destroy() {
      clearTimeout(searchTimer);
      popup.remove();
    },
  };
}
