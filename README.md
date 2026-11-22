# Verso — page-flip book reader

Verso is a small web app for reading PDF and EPUB books with a realistic page-turn animation. Books stay on your device, in your browser's storage. Nothing is uploaded anywhere.

**Live app:** https://adithyadaine.github.io/book-reader/

## Contents

- [Features](#features)
- [Install on iPhone or iPad](#install-on-iphone-or-ipad)
- [Reading controls](#reading-controls)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Run locally](#run-locally)
- [Deploy](#deploy)
- [Known limitations](#known-limitations)

## Features

- **PDF and EPUB:** PDFs keep their original page layout. EPUB text is split into pages that fit your screen.
- **Page-flip reading:** One page at a time on phones, two pages side by side on wider screens.
- **Table of contents:** Jump to any chapter. It uses the EPUB's built-in contents or the PDF's bookmarks.
- **Library with covers:** Covers come from the PDF's first page or the EPUB's cover image. A progress bar shows how far you've read.
- **Collections:** Group books into named collections.
- **Remembers your place:** Each book reopens where you left off.
- **Dark mode** for both text and PDF pages.
- **Bookmarks:** Bookmark any page. In EPUBs, bookmarks and your reading position stay on the same passage when you change the font, font size or screen size.
- **Private and works offline:** Books are stored only in this browser. After the first visit, the app opens without an internet connection.

## Install on iPhone or iPad

1. Open the live app in Safari.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Verso from the home screen. It runs full screen, like an app.

> Books are saved inside the installed app's own storage. A book added in Safari won't show up in the home-screen app, and the other way around.

## Reading controls

| Action | Touch | Keyboard / mouse |
| --- | --- | --- |
| Next / previous page | Swipe, or tap the right / left edge | → / ← |
| Show toolbar and slider | Tap the middle of the page | Click the middle |
| Table of contents | Tap the middle, then ☰ | Same |
| Jump to a page | Drag the slider | Same |
| Dark mode | ☼ in the toolbar | Same |
| Back to library | ← Library | Same |

The toolbar hides by itself after 5 seconds.

## How it works

- **Storage:** Book files and covers are kept in IndexedDB. Reading positions and collections are kept in `localStorage`. The app asks the browser for persistent storage so your books aren't cleared automatically.
- **PDF:** Pages are drawn with [pdf.js](https://mozilla.github.io/pdf.js/). Only pages near the one you're reading are drawn. The rest are released to save memory.
- **EPUB:** The file is unzipped with [JSZip](https://stuk.github.io/jszip/). Each chapter is laid out in columns that match the page size, and each column becomes one page.
- **Page turns:** Handled by [StPageFlip](https://github.com/Nodlik/StPageFlip) (`page-flip`).

- **Offline:** A service worker (`sw.js`) caches the app and its libraries. Books are already in IndexedDB, so the whole app works without a connection.
- **Safety:** EPUB chapters are cleaned before they're shown. Scripts, embedded frames, forms, event-handler attributes and `javascript:` links are removed. A Content Security Policy in `index.html` blocks scripts from anywhere but the app itself, as a second layer of protection.

All three libraries are kept in `vendor/`, so nothing loads from a CDN at runtime. There's no build step.

## Project structure

```
index.html      App layout (library + reader)
app.js          All logic: storage, library, PDF/EPUB rendering, contents, controls
style.css       Styles
manifest.json   Home-screen app settings (name, colors, icons)
sw.js           Service worker that caches the app for offline use
vendor/         page-flip, pdf.js (+ worker) and JSZip, unmodified copies
*-v4.png/.ico   Current icons (older icon versions are unused)
```

## Run locally

Any static file server works. For example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk (`file://`) may block the PDF worker, so use a server.

## Deploy

The app is hosted with GitHub Pages from the `main` branch. After changing `app.js` or `style.css`, raise the `?v=` number on their links in `index.html` and raise `VERSION` in `sw.js` to the same number. Otherwise phones may keep using the old cached copy.

## Known limitations

- Very large PDFs can still use a lot of memory on older phones.
- EPUB styling is simplified. The book's own CSS is removed so text fits the page.
- Rotating the device or resizing the window lays out the book again, which can take a moment for long EPUBs.
- There's no sync between devices.
