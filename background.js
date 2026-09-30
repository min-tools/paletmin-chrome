// Stores each tab's mode and updates the toolbar icon. content.js and
// page.js apply the override inside each tab and report Chrome's scheme so
// the icon matches the toolbar.

const TITLES = {
  auto: 'Auto palette',
  dark: 'Dark palette',
  light: 'Light palette',
};

let queue = Promise.resolve();

// serial(task)
// Run a task after earlier tasks finish. This prevents rapid clicks and
// messages from interleaving storage operations. Log failures without
// blocking the queue.
function serial(task) {
  const result = queue.then(task);
  queue = result.catch((err) => console.error(err));
  return result;
}

// load()
// Read Chrome's scheme and the saved per-tab modes. Local storage preserves
// the scheme across browser restarts; it defaults to light until a page
// reports it. Session storage preserves modes across worker restarts and
// clears them when the browser session ends.
async function load() {
  const [{ scheme = 'light' }, { modes = {} }] = await Promise.all([
    chrome.storage.local.get('scheme'),
    chrome.storage.session.get('modes'),
  ]);
  return { scheme, modes };
}

// nextMode(mode, scheme)
// Return the mode after mode. Put the scheme opposite Chrome's first so the
// first click always selects a different scheme.
function nextMode(mode, scheme) {
  const other = scheme === 'dark' ? 'light' : 'dark';
  return { auto: other, [other]: scheme, [scheme]: 'auto' }[mode];
}

// paint(mode, scheme, [tabId])
// Show a mode's icon and tooltip for one tab. If tabId is omitted, set the
// default for tabs without an override. icons/<scheme>/ contains glyphs for
// Chrome's light and dark toolbars.
function paint(mode, scheme, tabId) {
  const icon = (size) => `icons/${scheme}/${mode}-${size}.png`;
  return Promise.all([
    chrome.action.setIcon({ tabId, path: { 16: icon(16), 32: icon(32) } }),
    chrome.action.setTitle({ tabId, title: TITLES[mode] }),
  ]);
}

// setMode(tabId, mode)
// Save a tab's mode and repaint its icon. Do not store Auto tabs.
async function setMode(tabId, mode) {
  const { scheme, modes } = await load();
  if (mode === 'auto') delete modes[tabId];
  else modes[tabId] = mode;
  await chrome.storage.session.set({ modes });
  await paint(mode, scheme, tabId).catch(() => {}); // The tab may have closed.
}

// setScheme(scheme)
// Store a scheme reported by a page. If it changed, repaint the default icon
// and every tab's icon. Ignore invalid values.
async function setScheme(scheme) {
  if (scheme !== 'dark' && scheme !== 'light') return;
  // Read the raw value because load() supplies a default before the first
  // report.
  const { scheme: previous } = await chrome.storage.local.get('scheme');
  if (previous === scheme) return;
  const { modes } = await load();
  await chrome.storage.local.set({ scheme });
  await paint('auto', scheme);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) =>
    paint(modes[tab.id] ?? 'auto', scheme, tab.id).catch(() => {})));
}

// restore()
// Restore the default icon from the last known scheme. After a browser start
// or extension reload, Chrome uses the neutral manifest icon until a page
// reports its scheme. New Tab and chrome:// pages never report one. The next
// ordinary page load corrects a stale scheme.
async function restore() {
  const { scheme } = await load();
  await paint('auto', scheme);
}

// Move the tab to its next mode after a toolbar click or keyboard shortcut.
chrome.action.onClicked.addListener((tab) => serial(async () => {
  const { scheme, modes } = await load();
  let mode = nextMode(modes[tab.id] ?? 'auto', scheme);
  try {
    // Apply the mode in every frame that has a content script.
    await chrome.tabs.sendMessage(tab.id, { type: 'set', mode });
  } catch (err) {
    // Protected pages such as chrome:// and the Web Store have no content
    // script.
    console.warn(`Tab ${tab.id}: ${err.message}`);
    mode = 'auto';
  }
  await setMode(tab.id, mode);
}));

// Forget a closed tab before Chrome reuses its ID.
chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  const { modes } = await load();
  if (!modes[tabId]) return;
  delete modes[tabId];
  await chrome.storage.session.set({ modes });
}));

// Repaint per-tab icons after navigation because Chrome may reset them.
chrome.tabs.onUpdated.addListener((tabId, { status }) => {
  if (!status) return;
  serial(async () => {
    const { scheme, modes } = await load();
    await paint(modes[tabId] ?? 'auto', scheme, tabId).catch(() => {});
  });
});

// Handle content-script messages. Return true when respond() must remain
// available after this listener returns.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;

  // Update the icons when Chrome's scheme changes.
  if (message.type === 'scheme') {
    serial(() => setScheme(message.scheme));
    return;
  }

  // Return the mode requested by a loading frame and paint its tab's icon.
  if (message.type === 'get') {
    serial(async () => {
      await setScheme(message.scheme);
      const { scheme, modes } = await load();
      const tabId = sender.tab?.id;
      const mode = modes[tabId] ?? 'auto';
      if (tabId !== undefined) await paint(mode, scheme, tabId).catch(() => {});
      respond({ mode });
    });
    return true;
  }

});

// Replace the manifest icon after Chrome starts.
chrome.runtime.onStartup.addListener(() => serial(restore));

// Chrome normally injects content scripts only into pages loaded after the
// extension. Inject them into existing tabs after installation or an update.
// Each new instance tells the previous one to undo its changes.
chrome.runtime.onInstalled.addListener(async () => {
  serial(restore);
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  for (const tab of tabs) {
    const target = { tabId: tab.id, allFrames: true };
    // Install page.js before content.js announces a mode. Ignore failures on
    // protected pages.
    chrome.scripting.executeScript({ target, files: ['page.js'], world: 'MAIN', injectImmediately: true })
      .then(() => chrome.scripting.executeScript({ target, files: ['content.js'], injectImmediately: true }))
      .catch(() => {});
  }
});
