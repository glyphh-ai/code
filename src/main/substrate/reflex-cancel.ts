/**
 * reflex.cancel — graceful cancellation propagation.
 *
 * Wraps any awaitable in an abort-aware shell. If the signal fires
 * before the promise settles, the shell rejects with AbortError.
 *
 * Native AbortSignal semantics — provided here as a substrate primitive
 * so skill code can compose without re-implementing the pattern.
 */

export class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

export async function reflexCancel<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new AbortError();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
