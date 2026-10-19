/**
 * Trailing-edge debounce with a cancel, plus a notion of "settled".
 *
 * A coding agent writes files in bursts — ten files in two seconds, then
 * nothing. Assessing after the first write is assessing a half-applied change,
 * which produces findings that are real for a state that existed for 200ms and
 * then vanished. So the trigger waits for quiet, and the wait is longer than
 * you would use for a human typing.
 */

export interface Debounced {
  trigger(): void;
  cancel(): void;
  /** True while a run is pending. */
  readonly pending: boolean;
  dispose(): void;
}

export function debounce(fn: () => void | Promise<void>, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queuedWhileRunning = false;

  const fire = () => {
    timer = undefined;

    // If a run is already in flight, remember that more changes arrived rather
    // than starting a second overlapping assessment.
    if (running) {
      queuedWhileRunning = true;
      return;
    }

    running = true;
    void Promise.resolve(fn())
      .catch(() => {
        // The caller is responsible for reporting; swallowing here keeps a
        // failed run from killing the debounce loop.
      })
      .finally(() => {
        running = false;
        if (queuedWhileRunning) {
          queuedWhileRunning = false;
          api.trigger();
        }
      });
  };

  const api: Debounced = {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      queuedWhileRunning = false;
    },
    get pending() {
      return timer !== undefined || running;
    },
    dispose() {
      api.cancel();
    },
  };

  return api;
}
