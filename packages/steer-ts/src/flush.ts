/** How long a flush before a claim or a self-check may hold up the agent's call. */
export const FLUSH_TIMEOUT_MS = 500;

/** The flush under way, and the SDK it belongs to. */
let running: { sdk: object; done: Promise<void> } | undefined;

/**
 * Runs the SDK's flush and waits for it at most FLUSH_TIMEOUT_MS, like the Python hook. A neatroots
 * that takes the connection but doesn't answer (busy or stuck) holds the Neatlogs SDK's flush for
 * about 10 s while it retries, and the agent's call must not wait for that.
 *
 * A flush that is still running on the same SDK isn't started again; a different SDK (the app
 * configured another one) gets its own.
 */
export async function boundedFlush(sdk: object, flush: () => Promise<unknown>): Promise<void> {
  if (running?.sdk !== sdk) {
    const done: Promise<void> = (async () => {
      try {
        await flush();
      } catch {
        /* ignore */
      }
    })().finally(() => {
      if (running?.done === done) running = undefined;
    });
    running = { sdk, done };
  }
  // A plain timer, not unref'd: the caller is waiting on it, so it must keep the process alive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });
  await Promise.race([running.done, waited]);
  clearTimeout(timer);
}
