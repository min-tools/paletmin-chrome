# Privacy policy

Paletmin Palette Toggle does not collect, store, or share personal data. It has no analytics, accounts, or servers. It sends nothing about you or the pages you visit to the developer or anyone else.

## What the extension processes

The extension runs scripts in each tab to switch between a page's light and dark palettes. These scripts read accessible stylesheet rules and `media` attributes, then swap `dark` and `light` in the `prefers-color-scheme` queries they find. They also patch the page's `matchMedia()` so the page's scripts see the same preference. This processing stays inside the tab and is not recorded or sent anywhere.

## Network requests

The extension makes no network requests. It cannot read rules inside cross-origin stylesheets, so it leaves them unchanged.

## What is stored

- Each tab's mode is kept in Chrome's session storage. It is removed when the tab closes or Chrome quits.
- Chrome's light or dark scheme is kept in Chrome's local storage so the toolbar icon is correct after a restart.

No page content, URLs, or browsing history are stored.

## Permissions

- **Read and change all your data on all websites**: lets the extension run its scripts in every tab.
- **scripting**: adds the scripts to tabs that are already open after installation or an update.
- **storage**: used for the two items listed above.

## Changes

Changes to this policy are published in the [extension's repository](https://github.com/min-tools/paletmin-chrome). To ask a question, open an issue there.
