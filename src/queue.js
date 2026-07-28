export function createWorkPool({ concurrency = 2, worker }) {
  const pending = { image: [], video: [] };
  const active = new Map();
  let limit = concurrency;
  let nextType = "image";
  let stopped = false;
  const idleWaiters = [];

  function resolveIdle() {
    if (active.size || pending.image.length || pending.video.length) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function takeNext() {
    const other = nextType === "image" ? "video" : "image";
    const type = pending[nextType].length ? nextType : pending[other].length ? other : "";
    if (!type) return null;
    nextType = type === "image" ? "video" : "image";
    return pending[type].shift();
  }

  function pump() {
    while (!stopped && active.size < limit) {
      const item = takeNext();
      if (!item) break;
      active.set(item.id, item);
      Promise.resolve(worker(item)).finally(() => {
        active.delete(item.id);
        pump();
        resolveIdle();
      });
    }
  }

  return {
    add(items) {
      for (const item of items) pending[item.type].push(item);
      queueMicrotask(pump);
    },
    cancel(id) {
      for (const type of ["image", "video"]) {
        const index = pending[type].findIndex((item) => item.id === id);
        if (index >= 0) return pending[type].splice(index, 1)[0];
      }
      return null;
    },
    setConcurrency(value) {
      limit = Math.max(1, Math.min(20, Number(value) || 2));
      pump();
    },
    stop() {
      stopped = true;
      const queued = [...pending.image.splice(0), ...pending.video.splice(0)];
      resolveIdle();
      return { active: [...active.values()], queued };
    },
    waitForIdle() {
      if (!active.size && !pending.image.length && !pending.video.length) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
