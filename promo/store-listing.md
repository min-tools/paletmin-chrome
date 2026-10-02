# Chrome Web Store listing

## Name

Paletmin Palette Toggle

## Summary (132 characters max)

Switch the current tab between light and dark palettes with one click. No popup, no settings, no data collection.

## Description

Paletmin Palette Toggle switches the current tab between a website's light and dark palettes.

Click the toolbar icon to cycle through three modes:

• Auto: the tab follows Chrome's light or dark mode.
• Dark: the website shows its dark palette.
• Light: the website shows its light palette.

Each tab keeps its mode until you close it or quit Chrome, so one site can be dark while the rest of the browser stays light. The icon shows the current mode and matches Chrome's toolbar. You can also assign a keyboard shortcut at chrome://extensions/shortcuts.

The extension changes the color scheme a website thinks you prefer, using the same signal as your operating system. It rewrites the website's matching media queries and does not add a theme of its own. If a website has no dark theme or ignores the system preference, nothing changes.

What it does not do:

• No popup, settings page, or account.
• No data collection, analytics, or tracking.
• No network requests.

Why it needs access to all websites: Chrome describes running the extension's scripts in each tab as "read and change all your data on all websites". The scripts read and rewrite accessible stylesheet rules inside the tab. They do not send the data anywhere.

Privacy policy: https://github.com/min-tools/paletmin-chrome/blob/main/PRIVACY.md

Open source under the MIT license: https://github.com/min-tools/paletmin-chrome

## Category

Accessibility

## Screenshots

promo/screenshot.png (1280×800) and promo/screenshot-small.png (640×400)
