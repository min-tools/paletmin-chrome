// Read Chrome's native scheme without waiting for a website to load. This
// bundled document has no UI and makes no external requests.
const schemeList = matchMedia('(prefers-color-scheme: dark)');
let reported;

// scheme()
// Return the scheme used to choose contrasting toolbar glyphs.
const scheme = () => schemeList.matches ? 'dark' : 'light';

// report()
// Repaint icons when Chrome's native scheme changes, including on protected
// pages where content scripts cannot run.
function report() {
  const current = scheme();
  if (current === reported) return;
  reported = current;
  chrome.runtime.sendMessage({ type: 'toolbar-scheme', scheme: current })
    .catch(() => { reported = undefined; });
}

// Reply directly so a restarting worker can initialize before handling a click.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && message.type === 'read-toolbar-scheme') {
    respond({ scheme: scheme() });
  }
});
schemeList.addEventListener('change', report);
// Offscreen documents can skip media-query change events. Reading matches
// still returns the current value; only a change sends a message and wakes
// the worker. This timer does not run in, or keep alive, the service worker.
setInterval(report, 1000);
report();
