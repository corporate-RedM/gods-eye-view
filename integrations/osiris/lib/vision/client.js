// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
let worker = null;
let nextId = 0;
const waiting = new Map();
function getWorker() {
    if (worker)
        return worker;
    worker = new Worker(new URL('./vision.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
        const job = waiting.get(data.id);
        if (!job)
            return;
        waiting.delete(data.id);
        if (data.analysis)
            job.resolve(data.analysis);
        else
            job.reject(new Error(data.error || 'The frame could not be analysed'));
    };
    // A worker that never starts fails every frame, and the next request starts a fresh one.
    worker.onerror = event => {
        for (const job of waiting.values())
            job.reject(new Error(event.message || 'The detector could not start'));
        waiting.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}
/** Counts what is in a frame. The bitmap is handed over to the worker, not copied. */
export function analyseBitmap(image, at, session) {
    const id = ++nextId;
    const target = getWorker();
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        target.postMessage({ type: 'analyse', id, image, at, session }, [image]);
    });
}
/** Drops what the worker remembers of a camera, so a later watch starts fresh. */
export function forgetSession(session) {
    worker?.postMessage({ type: 'forget', session });
}
/** A still camera's current frame, through OSIRIS. */
export async function grabStill(cameraId, signal) {
    const res = await fetch(`/api/eye/cctv/frame?id=${encodeURIComponent(cameraId)}`, { signal });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `The camera's frame could not be fetched (${res.status})`);
    }
    const blob = await res.blob();
    const image = await createImageBitmap(blob);
    return { image, url: URL.createObjectURL(blob), at: res.headers.get('x-frame-at') || new Date().toISOString() };
}
/** The frame a live stream is showing now. */
export async function grabVideo(video) {
    if (video.readyState < 2 || !video.videoWidth)
        throw new Error('The stream has not started playing yet');
    const image = await createImageBitmap(video);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    let blob;
    try {
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    }
    catch {
        image.close();
        throw new Error('The browser will not let this feed be read');
    }
    if (!blob) {
        image.close();
        throw new Error('The stream frame could not be captured');
    }
    return { image, url: URL.createObjectURL(blob), at: new Date().toISOString() };
}
