// Applies the tab's mode to this document. If the selected scheme differs
// from Chrome's, swaps dark and light in accessible prefers-color-scheme
// queries. These queries can appear in stylesheet rules, media attributes,
// and matchMedia() calls handled by page.js. Pages that support both schemes
// also get a forced color-scheme for light-dark() and form controls.
//
// Runs in every frame's isolated world at document_start. matchMedia() here
// is Chrome's native implementation rather than the version page.js patches.
//
// After an extension update or reload, Chrome injects a new copy while the
// old copy's changes remain in the document. page.js first tells the old
// content script to restore the page and stop. Its persistent controller
// remains so existing MediaQueryList objects continue to work.
//
// The same happens without an update when a frame's initial about:blank
// document is replaced by a same-origin page: Chrome keeps the window, so
// the copy injected into about:blank stays alive next to the new one. The
// current reset is received on the window, which both copies share. page.js
// also sends it to the document so the previous build can retire cleanly.
(() => {
  const MENTION = /prefers-color-scheme/i;
  const RESET = 'palette-toggle:content-reset';
  let mode = 'auto'; // 'auto', 'dark', or 'light'
  let observer; // Watches for new styles while a scheme is forced.
  let pending; // Pending apply() timer.
  const applied = new WeakMap(); // Rule or element -> { original, applied }
  const schemeSheet = new CSSStyleSheet(); // Holds the forced color-scheme rule.

  // system()
  // Return Chrome's current scheme: 'dark' or 'light'.
  const system = () =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  // swapNeeded()
  // Return true when the forced scheme differs from Chrome's scheme.
  const swapNeeded = () => mode !== 'auto' && mode !== system();

  // swap(query)
  // Exchange dark and light in each prefers-color-scheme feature.
  const swap = (query) => query.replace(
    /(prefers-color-scheme\s*:\s*)(dark|light)/gi,
    (_, prefix, value) =>
      prefix + (value.toLowerCase() === 'dark' ? 'light' : 'dark'));

  // rewrite(key, get, set)
  // Rewrite one media query for the current mode. get and set access its
  // text. key identifies the rule or element whose original text must be
  // restored. Treat external changes as a new original and skip queries
  // that do not mention prefers-color-scheme.
  function rewrite(key, get, set) {
    const current = get();
    let entry = applied.get(key);
    // Record a new query or one the page changed after the last rewrite.
    if (!entry || entry.applied !== current) {
      if (!MENTION.test(current)) return;
      entry = { original: current, applied: current };
      applied.set(key, entry);
    }
    const wanted = swapNeeded() ? swap(entry.original) : entry.original;
    if (wanted === current) return;
    try {
      set(wanted);
      entry.applied = get();
    } catch {
      // Leave rules unchanged when they reject the new media text.
    }
  }

  // visitRules(rules)
  // Rewrite each rule in a CSSRuleList, including @import sheets and nested
  // groups such as @supports and @layer.
  function visitRules(rules) {
    for (const rule of rules) {
      // @media and @import rules can carry a media list.
      if (rule.media) {
        rewrite(rule, () => rule.media.mediaText,
          (text) => { rule.media.mediaText = text; });
      }
      if (rule.styleSheet) visitSheet(rule.styleSheet);
      if (rule.cssRules) visitRules(rule.cssRules);
    }
  }

  // visitSheet(sheet)
  // Rewrite accessible stylesheet rules. Leave cross-origin sheets unchanged.
  function visitSheet(sheet) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // Reading rules throws for cross-origin sheets.
    }
    visitRules(rules);
  }

  // applyColorScheme()
  // Force color-scheme on the root and body only when their computed values
  // support both schemes. Forcing a single-scheme page could incorrectly
  // change its canvas and form controls.
  function applyColorScheme() {
    // Remove the previous rule before reading the page's computed value.
    const sheets = document.adoptedStyleSheets;
    if (sheets.includes(schemeSheet)) {
      document.adoptedStyleSheets = sheets.filter((s) => s !== schemeSheet);
    }
    if (mode === 'auto') return;

    // Return whether an element supports both light and dark.
    const both = (element) => {
      if (!element) return false;
      const scheme = getComputedStyle(element).colorScheme;
      return /\blight\b/.test(scheme) && /\bdark\b/.test(scheme);
    };
    const selectors = [];
    if (both(document.documentElement)) selectors.push(':root');
    if (both(document.body)) selectors.push('body');
    if (!selectors.length) return;

    // Use an adopted sheet so an inline-style CSP cannot block the rule.
    schemeSheet.replaceSync(
      `${selectors.join(', ')} { color-scheme: ${mode} !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, schemeSheet];
  }

  // apply()
  // Apply the current mode to stylesheets, media attributes, and
  // color-scheme. Auto restores the original values.
  function apply() {
    pending = undefined;
    if (!document.documentElement) return;
    for (const sheet of document.styleSheets) visitSheet(sheet);
    for (const sheet of document.adoptedStyleSheets) visitSheet(sheet);
    // Rewrite media attributes on any element that has one.
    for (const element of document.querySelectorAll('[media]')) {
      rewrite(element, () => element.getAttribute('media'),
        (text) => element.setAttribute('media', text));
    }
    applyColorScheme();
  }

  // schedule()
  // Schedule apply(), combining several requests into one run.
  function schedule() {
    pending ??= setTimeout(apply, 0);
  }

  // watch()
  // Watch for styles added by the parser or page scripts. Repeated calls are
  // safe.
  function watch() {
    observer ??= new MutationObserver((records) => {
      for (const record of records) {
        // Reapply after a media attribute changes.
        if (record.type === 'attributes') return schedule();
        // Reapply when text is added inside a style element.
        if (record.target.nodeName === 'STYLE') return schedule();
        // Reapply when a new subtree contains styles or media attributes.
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('style, link, [media]') ||
              node.querySelector('style, link, [media]')) {
            return schedule();
          }
        }
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['media'],
    });
  }

  // setMode(next)
  // Switch this document to the requested mode, notify page.js, update the
  // observer, and rewrite the document.
  function setMode(next) {
    mode = next;
    document.dispatchEvent(new Event(`palette-toggle:${mode}`));
    if (mode === 'auto') {
      // Stop watching because Auto does not rewrite later changes.
      observer?.disconnect();
    } else {
      watch();
    }
    apply();
  }

  // A linked stylesheet loads after its element. Capture its non-bubbling
  // load event so the new rules are rewritten.
  const onLoad = (event) => {
    if (mode !== 'auto' && event.target.nodeName === 'LINK') schedule();
  };

  // Reapply when Chrome's scheme changes. The top frame also tells the worker
  // to repaint the toolbar icons.
  const onScheme = () => {
    if (mode !== 'auto') schedule();
    if (window === top) {
      chrome.runtime.sendMessage({ type: 'scheme', scheme: system() })
        .catch(() => {});
    }
  };

  // Apply modes sent by the worker after a toolbar click or shortcut.
  const onMessage = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'set') return;
    setMode(message.mode);
    respond(true);
  };

  // retire()
  // Restore the page and stop this copy after a newer copy starts.
  const retire = () => {
    window.removeEventListener(RESET, retire);
    document.removeEventListener('load', onLoad, true);
    schemeList.removeEventListener('change', onScheme);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // The old runtime is unavailable after an extension reload.
    }
    clearTimeout(pending);
    setMode('auto');
  };

  // page.js has already retired older content scripts.
  window.addEventListener(RESET, retire);
  document.addEventListener('load', onLoad, true);
  const schemeList = matchMedia('(prefers-color-scheme: dark)');
  schemeList.addEventListener('change', onScheme);
  chrome.runtime.onMessage.addListener(onMessage);

  // Request the tab's mode and report Chrome's scheme for the toolbar icon.
  chrome.runtime.sendMessage({ type: 'get', scheme: system() })
    .then((reply) => {
      if (['auto', 'dark', 'light'].includes(reply?.mode)) setMode(reply.mode);
    })
    .catch(() => {}); // The worker may be unavailable just after an update.
})();
