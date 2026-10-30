// Requests that give up. On the road a request can stall without failing (a dead zone, a tower handoff), and a
// stalled request kept its source busy so nothing was asked again. `work(signal)` makes the request and reads
// the answer; after `ms` it is aborted and the call fails like any other error, so the caller's backoff and its
// "unavailable" status take over (never a "none" or an all clear).
export async function withTimeout(work, ms) {
  const ctrl = new AbortController();
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`no answer in ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}
