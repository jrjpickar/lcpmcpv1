const frameHub = Symbol.for('lcp.animationFrame');

function createFrameHub() {
  const callbacks = new Map();
  let pending = 0;
  let sequence = 0;

  function schedule() {
    if (!pending && callbacks.size && !document.hidden) pending = requestAnimationFrame(render);
  }

  function render(now) {
    pending = 0;
    const batch = [...callbacks.keys()];
    for (const id of batch) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.(now);
    }
    schedule();
  }

  document.documentElement.classList.toggle('tab-hidden', document.hidden);
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('tab-hidden', document.hidden);
    if (document.hidden) {
      cancelAnimationFrame(pending);
      pending = 0;
    } else schedule();
  });
  return {
    request(callback) {
      const id = ++sequence;
      callbacks.set(id, callback);
      schedule();
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
      if (!callbacks.size && pending) {
        cancelAnimationFrame(pending);
        pending = 0;
      }
    },
  };
}

export const frames = globalThis[frameHub] ||= createFrameHub();
