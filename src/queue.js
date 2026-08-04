export function createWorkPool({ concurrency = 2, worker }) {
  const types = ["image", "video", "audio"];
  const pending = Object.fromEntries(types.map((type) => [type, []]));
  const active = new Map();
  let limit = concurrency;
  let nextTypeIndex = 0;
  let stopped = false;
  const idleWaiters = [];

  function resolveIdle() {
    if (active.size || types.some((type) => pending[type].length)) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function takeNext() {
    for (let offset = 0; offset < types.length; offset += 1) {
      const index = (nextTypeIndex + offset) % types.length;
      const type = types[index];
      if (!pending[type].length) continue;
      nextTypeIndex = (index + 1) % types.length;
      return pending[type].shift();
    }
    return null;
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
      for (const type of types) {
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
      const queued = types.flatMap((type) => pending[type].splice(0));
      resolveIdle();
      return { active: [...active.values()], queued };
    },
    waitForIdle() {
      if (!active.size && !types.some((type) => pending[type].length)) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
