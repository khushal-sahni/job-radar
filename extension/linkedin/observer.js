(function () {
  const ns = (window.JobRadarLi = window.JobRadarLi || {});

  const MAX_QUEUE = 5;
  const MIN_DELAY_MS = 1000;
  const MAX_DELAY_MS = 1600;
  const BACKOFF_MS = 5000;

  function randomDelay() {
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createObserver(handlers) {
    const { onVisible } = handlers;
    const visible = new Map();
    const queued = [];
    const queuedIds = new Set();
    const processed = new Set();
    let processing = false;
    let stopped = false;
    let backoffUntil = 0;
    let io = null;

    function fillQueue() {
      for (const [id, entry] of visible) {
        if (queued.length >= MAX_QUEUE) break;
        if (processed.has(id) || queuedIds.has(id)) continue;
        queued.push(entry);
        queuedIds.add(id);
      }
    }

    async function pump() {
      if (processing || stopped) return;
      processing = true;
      try {
        fillQueue();
        while (queued.length > 0 && !stopped) {
          const wait = backoffUntil - Date.now();
          if (wait > 0) await sleep(wait);

          const entry = queued.shift();
          queuedIds.delete(entry.id);
          if (!visible.has(entry.id)) {
            fillQueue();
            continue;
          }

          try {
            await onVisible(entry);
            processed.add(entry.id);
          } catch {
            backoffUntil = Date.now() + BACKOFF_MS;
            if (!queuedIds.has(entry.id) && queued.length < MAX_QUEUE) {
              queued.push(entry);
              queuedIds.add(entry.id);
            }
          }

          fillQueue();
          if (queued.length > 0 && !stopped) await sleep(randomDelay());
        }
      } finally {
        processing = false;
        if (!stopped && queued.length > 0) void pump();
      }
    }

    function observeRoot() {
      if (!io) {
        io = new IntersectionObserver(
          (entries) => {
            for (const obs of entries) {
              const el = obs.target;
              const id =
                ns.parser.jobIdFromEl(el) ||
                el.getAttribute("data-job-radar-id") ||
                "";
              if (!id) continue;
              if (obs.isIntersecting && obs.intersectionRatio >= 0.02) {
                visible.set(id, { id, el });
                fillQueue();
                void pump();
              } else {
                visible.delete(id);
              }
            }
          },
          { root: null, threshold: [0, 0.05, 0.2, 0.35], rootMargin: "80px" },
        );
      }

      const cards = ns.parser.findCardElements(document);
      for (const { el, job } of cards) {
        el.setAttribute("data-job-radar-id", job.id);
        io.observe(el);
      }
    }

    function disconnect() {
      io?.disconnect();
      io = null;
      visible.clear();
      queued.length = 0;
      queuedIds.clear();
    }

    function stop() {
      stopped = true;
      disconnect();
    }

    function start() {
      stopped = false;
      processed.clear();
      observeRoot();
    }

    return { start, stop, observeRoot };
  }

  ns.observer = { createObserver };
})();
