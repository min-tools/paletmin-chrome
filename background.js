// Keep per-tab modes and palette detection in session storage. The offscreen
// document supplies Chrome's native scheme independently of website scripts.
const TITLES = {
  auto: 'Auto palette',
  dark: 'Dark palette',
  light: 'Light palette',
};
const unavailableIcons = new Map();
const navigations = new Map();
let queue = Promise.resolve();
let initialization;

// serial(task)
// Keep storage writes and rapid clicks in order, even after a task fails.
function serial(task) {
  const result = queue.then(task);
  queue = result.catch((err) => console.error(err));
  return result;
}

// load()
// Preserve modes and detection across worker restarts, and remember the last
// native scheme until the offscreen document reports its current value.
async function load() {
  const [{ scheme = 'light' }, { modes = {}, pages = {} }] = await Promise.all([
    chrome.storage.local.get('scheme'),
    chrome.storage.session.get(['modes', 'pages']),
  ]);
  return { scheme, modes, pages };
}

// nextMode(mode, scheme)
// Offer the opposite of this page's native scheme on the first click.
function nextMode(mode, scheme) {
  const other = scheme === 'dark' ? 'light' : 'dark';
  return { auto: other, [other]: scheme, [scheme]: 'auto' }[mode];
}

// unavailableIcon(scheme)
// Cross out the existing A glyph at both toolbar resolutions. Cache the
// ImageData so later repaints do not decode the packaged PNGs again.
function unavailableIcon(scheme) {
  if (!unavailableIcons.has(scheme)) {
    const drawing = Promise.all([16, 32].map(async (size) => {
      const response = await fetch(chrome.runtime.getURL(`icons/${scheme}/auto-${size}.png`));
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();

      // Match the glyph's own color, using its most opaque pixel.
      const pixels = context.getImageData(0, 0, size, size).data;
      let color = 0;
      for (let i = 4; i < pixels.length; i += 4) {
        if (pixels[i + 3] > pixels[color + 3]) color = i;
      }
      context.scale(size / 16, size / 16);
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(3, 13);
      context.lineTo(13, 3);
      // A transparent border keeps the slash visible across the filled glyph.
      context.globalCompositeOperation = 'destination-out';
      context.lineWidth = 3.5;
      context.stroke();
      context.globalCompositeOperation = 'source-over';
      context.strokeStyle = `rgb(${pixels[color]}, ${pixels[color + 1]}, ${pixels[color + 2]})`;
      context.lineWidth = 1.5;
      context.stroke();
      return [size, context.getImageData(0, 0, size, size)];
    })).then(Object.fromEntries);
    unavailableIcons.set(scheme, drawing);
    drawing.catch(() => unavailableIcons.delete(scheme));
  }
  return unavailableIcons.get(scheme);
}

// paint(mode, scheme, [tabId], [page])
// Show a contrasting mode icon, or a crossed-out A with the reason the page
// may not change. Detection is advisory; an accessible page can still be tried.
async function paint(mode, scheme, tabId, page) {
  // A late start misses earlier JavaScript queries. Only report no palette
  // after observing a fresh page load; otherwise keep the normal mode icon.
  const undetected = page?.ready && page.late === false && !page.supported;
  const unavailable = page?.blocked || undetected;
  let title = TITLES[mode];
  if (page?.blocked) {
    title = 'Palette switching is unavailable on this page (restricted page or site access denied).';
  } else if (undetected) {
    title = `No compatible palette detected on this page. ${TITLES[mode]}.`;
    if (page.opaque) title += ' Some stylesheets cannot be read.';
  } else if (page && !page.ready) {
    title = 'Checking this page for palette support…';
  }
  if (page?.late && !page.blocked) {
    if (!title.endsWith('.')) title += '.';
    title += ' If palette switching does not work, reload this page once.';
  }
  const icon = unavailable
    ? { imageData: await unavailableIcon(scheme) }
    : { path: { 16: `icons/${scheme}/${mode}-16.png`, 32: `icons/${scheme}/${mode}-32.png` } };
  await Promise.all([
    chrome.action.setIcon({ tabId, ...icon }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}

// setPage(tabId, page)
// Save only detection flags and a document token, never page content or URLs.
async function setPage(tabId, page) {
  const { scheme, modes, pages } = await load();
  const previous = pages[tabId];
  // A probe can finish after the same document has reported newer support.
  if (page?.key && previous?.key === page.key && previous.revision > page.revision) return;
  pages[tabId] = page;
  await chrome.storage.session.set({ pages });
  await paint(modes[tabId] ?? 'auto', scheme, tabId, page).catch(() => {});
}

// setScheme(scheme, [force])
// Repaint every tab after a native scheme change or worker initialization.
async function setScheme(scheme, force = false) {
  if (scheme !== 'dark' && scheme !== 'light') return;
  const { scheme: previous, modes, pages } = await load();
  if (!force && previous === scheme) return;
  await chrome.storage.local.set({ scheme });
  await paint('auto', scheme);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) =>
    paint(modes[tab.id] ?? 'auto', scheme, tab.id, pages[tab.id]).catch(() => {})));
}

// restore()
// Read the actual native scheme on installation and worker restart. A hidden
// extension document can use matchMedia even when every tab is protected.
async function restore() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['MATCH_MEDIA'],
        justification: 'Choose readable toolbar icons before a website loads and when the native color scheme changes.',
      });
    }
    const reply = await chrome.runtime.sendMessage({ type: 'read-toolbar-scheme' });
    await setScheme(reply.scheme, true);
  } catch (err) {
    console.warn(`Toolbar appearance: ${err.message}`);
    const { scheme } = await load();
    await setScheme(scheme, true);
  }
}

// ensureContent(tabId)
// Probe the top document before trying a late injection. Pin content.js to
// the documents that received page.js so navigation cannot split the pair.
async function ensureContent(tabId) {
  // Pin the late-start report to the injected document, not a new navigation.
  const probe = (documentId) => chrome.tabs.sendMessage(
    tabId, { type: 'probe', late: !!documentId },
    documentId ? { documentId } : { frameId: 0 });
  try {
    const reply = await probe();
    if (reply?.page) return reply;
  } catch {
    // Existing tabs, or tabs whose site access was just granted, may lack scripts.
  }
  const inject = async (target) => {
    const frames = await chrome.scripting.executeScript({
      target, files: ['page.js'], world: 'MAIN', injectImmediately: true,
    });
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: frames.map((frame) => frame.documentId) },
      files: ['content.js'], injectImmediately: true,
    });
    return frames.find((frame) => frame.frameId === 0)?.documentId;
  };
  let documentId;
  try {
    documentId = await inject({ tabId, allFrames: true });
  } catch {
    // A restricted child frame must not prevent initialization of the main page.
    documentId = await inject({ tabId, frameIds: [0] });
  }
  const reply = await probe(documentId);
  if (!reply?.page) throw new Error('The page did not respond');
  return reply;
}

// refreshTab(tabId)
// Initialize existing tabs concurrently; serialize only their state changes.
async function refreshTab(tabId) {
  const navigation = navigations.get(tabId);
  let page;
  try {
    page = (await ensureContent(tabId)).page;
  } catch {
    page = { blocked: true };
  }
  await serial(async () => {
    if (navigations.get(tabId) !== navigation) return;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return; // A closed tab must not recreate session entries.
    }
    await setPage(tabId, page);
  });
}

// Apply a click only after the top document confirms it can receive modes.
chrome.action.onClicked.addListener((tab) => serial(async () => {
  let reply;
  try {
    reply = await ensureContent(tab.id);
  } catch {
    await setPage(tab.id, { blocked: true });
    return;
  }
  const { scheme, modes, pages } = await load();
  const mode = nextMode(modes[tab.id] ?? 'auto', reply.scheme);
  try {
    // Broadcast to all accessible frames, including those with their own theme.
    await chrome.tabs.sendMessage(tab.id, { type: 'set', mode });
  } catch {
    await setPage(tab.id, { blocked: true });
    return;
  }
  if (mode === 'auto') delete modes[tab.id];
  else modes[tab.id] = mode;
  pages[tab.id] = reply.page;
  await chrome.storage.session.set({ modes, pages });
  await paint(mode, scheme, tab.id, reply.page).catch(() => {});
}));

// Clear both kinds of session data when the tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  navigations.delete(tabId);
  serial(async () => {
    const { modes, pages } = await load();
    delete modes[tabId];
    delete pages[tabId];
    await chrome.storage.session.set({ modes, pages });
  });
});

// Discard the old document's detection during navigation. Recheck on completion
// and activation to recover from installation races and changed site access.
chrome.tabs.onUpdated.addListener((tabId, { status }) => {
  if (status === 'loading') {
    navigations.set(tabId, (navigations.get(tabId) ?? 0) + 1);
    serial(() => setPage(tabId, { ready: false }));
  } else if (status === 'complete') {
    refreshTab(tabId).catch(console.error);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => refreshTab(tabId).catch(console.error));

// Accept appearance only from the bundled offscreen document. Website frames
// report detection and request modes, but cannot change the global icon color.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'toolbar-scheme' && sender.url === chrome.runtime.getURL('offscreen.html')) {
    serial(() => setScheme(message.scheme));
    return;
  }
  if (!sender.tab || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return;
  const tabId = sender.tab.id;
  if (message.type === 'get') {
    serial(async () => {
      if (sender.frameId === 0 && message.page?.key) await setPage(tabId, message.page);
      const { modes } = await load();
      respond({ mode: modes[tabId] ?? 'auto' });
    }).catch(() => respond({ mode: 'auto' }));
    return true;
  }
  if (message.type === 'status' && sender.frameId === 0 && message.page?.key) {
    serial(async () => {
      const { pages } = await load();
      // Ignore a replaced content script's queued report.
      if (pages[tabId]?.key && pages[tabId].key !== message.page?.key) return;
      await setPage(tabId, message.page);
    });
  }
});

// initialize()
// Recheck existing tabs once per extension session, including re-enabling on
// Chrome versions without onEnabled. Session storage is cleared on disable,
// update, and browser exit, but survives ordinary worker suspension.
function initialize() {
  initialization ??= serial(restore).then(async () => {
    const { initialized } = await chrome.storage.session.get('initialized');
    if (initialized) return;
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => refreshTab(tab.id)));
    await chrome.storage.session.set({ initialized: true });
  }).catch((err) => {
    initialization = undefined;
    throw err;
  });
  return initialization;
}

// Queue appearance first and share initialization across overlapping events.
initialize().catch(console.error);
chrome.runtime.onStartup.addListener(() => initialize().catch(console.error));
chrome.runtime.onInstalled.addListener(() => initialize().catch(console.error));
chrome.runtime.onEnabled?.addListener(() => initialize().catch(console.error));
