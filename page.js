// Runs in the page's JavaScript world before its scripts, making matchMedia()
// report the forced color scheme. content.js announces the tab's mode with a
// "palette-toggle:<mode>" document event.
//
// Changes only media queries that mention prefers-color-scheme.
//
// Keep the controller in the page across extension updates and reloads so
// existing MediaQueryList objects keep receiving correct values and events.
(() => {
  const LEGACY_RESET = 'palette-toggle:reset';
  const CONTENT_RESET = 'palette-toggle:content-reset';
  const CONTROLLER = Symbol.for('tools.min.paletmin.palette-toggle');
  const SUPPORT = Symbol.for('tools.min.paletmin.palette-support');
  const startedLate = !window[CONTROLLER] && document.readyState !== 'loading';

  // watchSupport()
  // Observe the page's own matchMedia calls after our patch is installed, so
  // internal evaluations do not falsely count as website palette support.
  // This also works with the persistent controller from the previous release.
  function watchSupport() {
    if (window[SUPPORT]) return;
    let owner = document;
    let used = false;
    let late = startedLate;
    const matchMedia = window.matchMedia;

    // announce()
    // Tell the isolated script what this document has used. A reused initial
    // about:blank window must not carry detection over to its real document.
    const announce = () => {
      if (owner !== document) {
        owner = document;
        used = false;
        late = false;
      }
      if (used) window.dispatchEvent(new Event('palette-toggle:supported'));
      if (late) window.dispatchEvent(new Event('palette-toggle:late'));
    };
    window.matchMedia = function matchMediaWithSupport(query) {
      announce();
      const list = Reflect.apply(matchMedia, this, arguments);
      if (/prefers-color-scheme/i.test(list.media) && !used) {
        used = true;
        announce();
      }
      return list;
    };
    window.addEventListener('palette-toggle:probe', announce);
    Object.defineProperty(window, SUPPORT, { value: true });
  }

  // Retire content scripts from the previous extension instance, and the
  // copy left over from a frame's initial about:blank document when Chrome
  // reused its window for a same-origin page. Send the current reset to the
  // document for the previous build and to the window for current builds.
  // The legacy event cleans up builds that predate the persistent controller.
  document.dispatchEvent(new Event(LEGACY_RESET));
  document.dispatchEvent(new Event(CONTENT_RESET));
  window.dispatchEvent(new Event(CONTENT_RESET));
  if (window[CONTROLLER]) {
    watchSupport();
    return;
  }

  const native = window.matchMedia;
  const real = native.bind(window);
  const tracked = new Set(); // WeakRefs to color-scheme query lists.
  const synthetic = new WeakSet(); // Change events created by this script.
  let forced = null; // 'dark', 'light', or null for Auto.

  // mentions(query)
  // Return whether a media query uses prefers-color-scheme.
  const mentions = (query) => /prefers-color-scheme/i.test(query);

  // system()
  // Return Chrome's current scheme: 'dark' or 'light'.
  const system = () =>
    real('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  // swap(query)
  // Exchange dark and light. Evaluating the result against Chrome's scheme
  // gives the answer for the opposite scheme.
  const swap = (query) => query.replace(
    /(prefers-color-scheme\s*:\s*)(dark|light)/gi,
    (_, prefix, value) =>
      prefix + (value.toLowerCase() === 'dark' ? 'light' : 'dark'));

  // evaluate(query)
  // Evaluate a query using the mode the page should see.
  const evaluate = (query) =>
    real(forced && forced !== system() ? swap(query) : query).matches;

  // matchMedia(query)
  // Replace window.matchMedia(). Return a native list whose matches getter
  // uses the forced scheme. Hide its native change events while forced.
  const patched = function matchMedia(query) {
    const list = real(query);
    if (!mentions(list.media)) return list;
    const media = list.media;
    Object.defineProperty(list, 'matches', {
      get: () => evaluate(media),
      configurable: true,
    });
    // While forced, Chrome's scheme cannot change the visible answer. Register
    // this listener first so it can suppress the native event.
    list.addEventListener('change', (event) => {
      if (forced && !synthetic.has(event)) event.stopImmediatePropagation();
    });
    tracked.add(new WeakRef(list));
    return list;
  };
  window.matchMedia = patched;

  // setMode(mode)
  // Apply 'auto', 'dark', or 'light'. Dispatch a change event for each
  // tracked list whose answer changes and discard collected lists.
  function setMode(mode) {
    // Save each live list's answer before changing the mode.
    const before = [];
    for (const ref of tracked) {
      const list = ref.deref();
      if (list) before.push([list, list.matches]);
      else tracked.delete(ref);
    }
    forced = mode === 'auto' ? null : mode;
    // Notify listeners as a native scheme change would.
    for (const [list, was] of before) {
      if (list.matches === was) continue;
      const event = new MediaQueryListEvent('change', {
        media: list.media,
        matches: list.matches,
      });
      synthetic.add(event);
      list.dispatchEvent(event);
    }
  }

  // Separate event types avoid passing data between JavaScript worlds.
  const handlers = ['auto', 'dark', 'light'].map((mode) =>
    [`palette-toggle:${mode}`, () => setMode(mode)]);
  for (const [type, handler] of handlers) {
    document.addEventListener(type, handler);
  }

  // Mark the persistent controller so later copies reuse its patch and
  // tracked MediaQueryList objects.
  Object.defineProperty(window, CONTROLLER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  watchSupport();
})();
