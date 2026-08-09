# Skyway Ops — marketing site

A self-contained static marketing site for the Skyway Ops platform and the
source for **https://135ops.app**. It is intentionally independent of the
operations app: no shared runtime, Firebase config, authentication, API routes,
or deployment configuration.

No build step: plain HTML, one stylesheet, one progressive-enhancement script,
and locally hosted image assets.

```
.
├── .github/workflows/ # standalone repository CI
├── scripts/           # dependency-free integrity checks
├── index.html          # the page
├── styles.css          # design system (shares the product's tokens/fonts)
├── app.js              # sticky nav, mobile drawer, scroll reveals, lightbox
├── vercel.json         # independent static deployment
└── assets/
    ├── favicon.png
    ├── skyway-logo.png
    └── screens/*.webp  # live captures of the real application
```

## Preview locally

```bash
cd marketing
python3 -m http.server 8088
# open http://localhost:8088
```

Run the dependency-free integrity check:

```bash
npm test
```

## Deploy

Create a repository named `135ops-marketing`, put the contents of this directory
at its root, and import that repository into Vercel. No framework preset or
build command is needed; the output directory is the repository root.

Attach `135ops.app` and `www.135ops.app` to that project, then remove those
domains from the app's Vercel project. See [`DOMAIN.md`](DOMAIN.md) for the
cutover order and Cloudflare records.

The included `vercel.json` supplies immutable asset caching, baseline security
headers, clean URLs, and the `www` → apex redirect.

## Screenshots

Every screen image is a real capture of the application, produced by the
screenshot harness that lives with the application source. The marketing
repository consumes only the optimized WebP output — it has no dependency on
the harness or the app.

To refresh from the app repository:

```bash
cd tools/screenshot-harness
node capture.mjs
node optimize.mjs
```

Then copy `marketing/assets/screens/*.webp` into this repository and run
`npm test`.

## Content note

All aircraft registrations, crew names, brokers, customers, and passengers on
the page and in the screenshots are fictional, used only for demonstration.
