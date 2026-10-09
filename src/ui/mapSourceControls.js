import { renderMapStackChips, syncMapStackChips } from '../mapStackChips.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 * An optional `labels` port (maps/placeLabels.js) gets an ON/OFF toggle for the
 * English borders and place names drawn over the satellite maps.
 */
export function createMapSourceControls({
  container,
  statusElement,
  controller,
  subscribe,
  labels = null,
  labelsToggle = null,
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  const removers = [];
  const bind = (element, type, listener) => {
    element.addEventListener(type, listener);
    removers.push(() => element.removeEventListener(type, listener));
  };
  /** Pressed while names are on; dimmed on maps that do not take them. */
  function renderLabels(activeId = controller.getActiveId()) {
    if (destroyed || !labels || !labelsToggle) return;
    const enabled = labels.isEnabled();
    labelsToggle.setAttribute('aria-pressed', String(enabled));
    labelsToggle.classList.toggle('active', enabled);
    labelsToggle.dataset.applies = String(
      labels.appliesTo?.(activeId) !== false,
    );
  }
  function render(state) {
    if (destroyed || !state) return;
    renderLabels(state.activeId);
    syncMapStackChips(container, state.activeId);
    if (statusElement) {
      const stack = state.activeStack;
      statusElement.textContent =
        state.status === 'switching'
          ? '...'
          : stack?.shortLabel || stack?.label || 'MAP';
      statusElement.classList.toggle('warn', !!state.lastError);
    }
  }
  async function select(stackId, { syncShare = true } = {}) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId);
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        onError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    if (state?.activeId === before && stackId !== before && state?.lastError)
      onError(state.lastError);
    if (syncShare) onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    for (const remove of removers.splice(0)) remove();
    renderMapStackChips(container, controller.getStacks(), {
      activeId: controller.getActiveId(),
      onSelect: (id) => {
        void select(id).catch(() => {});
      },
      bind,
    });
    render(controller.getState());
  }
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
  const toggleLabels = () => {
    if (destroyed || !labels) return;
    void labels.setEnabled(!labels.isEnabled());
    renderLabels();
  };
  labelsToggle?.addEventListener('click', toggleLabels);
  refresh();
  return {
    render,
    select,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      labelsToggle?.removeEventListener('click', toggleLabels);
      for (const remove of removers.splice(0)) remove();
    },
  };
}
