import { initFirstRunExperience } from '../firstRunExperience.js';

/** Reveal welcome controls only after restoration and the loading transition. */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  initializeSettings,
}) {
  let disposed = false;
  let firstRun;
  let revealTimer;
  let coverHidden = false;
  let coverTransitionDone = false;
  let restorationDone = false;
  let unsubscribeCameras;
  let resolveDelay;
  const minimumDelay = new Promise((resolve) => {
    resolveDelay = resolve;
  });
  const delayTimer = setTimeout(resolveDelay, 1000);
  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    coverTransitionDone = true;
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    if (restorationDone)
      firstRun = initializeWelcome?.({ styleManager, dataManager });
  };
  const hideCover = () => {
    if (disposed || signal.aborted || coverHidden) return;
    coverHidden = true;
    unsubscribeCameras?.();
    loadingScreen.classList.add('hidden');
    loadingScreen.addEventListener('transitionend', revealFirstRun, {
      once: true,
    });
    revealTimer = setTimeout(revealFirstRun, 900);
  };
  // CCTV restoration waits for provider collection and registration. Reveal
  // the existing GUI progress while that work runs, instead of covering it
  // until the entire catalogue has loaded. Welcome still waits for restoration.
  const cameras = dataManager.layers?.get('cctv')?.module;
  const showCameraProgress = (state) => {
    if (state?.catalogueLoading?.active) void minimumDelay.then(hideCover);
  };
  unsubscribeCameras = cameras?.subscribe?.(showCameraProgress);
  showCameraProgress(cameras?.getUIState?.());
  const restored = Promise.resolve(styleManager.initialRestorePromise)
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(() => {
      restorationDone = true;
      if (coverTransitionDone) revealFirstRun();
    });
  void Promise.all([restored, minimumDelay]).then(hideCover);
  const keySetup = Promise.resolve(
    signal.aborted ? null : initializeSettings?.({ signal }),
  );
  // Own the pending initializer too; it must not reveal a dialog after abort.
  void keySetup.catch(() =>
    console.error('Provider settings initialization failed'),
  );
  return async () => {
    disposed = true;
    unsubscribeCameras?.();
    clearTimeout(delayTimer);
    clearTimeout(revealTimer);
    resolveDelay();
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    firstRun?.destroy();
    (await keySetup.catch(() => null))?.destroy();
  };
}
