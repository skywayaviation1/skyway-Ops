# Skyway Ops — marketing site

A self-contained static marketing site for the Skyway Ops platform. No build
step: plain HTML, one stylesheet, one progressive-enhancement script, and
locally hosted image assets.

```
marketing/
├── index.html          # the page
├── styles.css          # design system (shares the product's tokens/fonts)
├── app.js              # sticky nav, mobile drawer, scroll reveals, lightbox
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

## Deploy

It is fully static — host `marketing/` on any static host (Vercel, Netlify,
S3/CloudFront, GitHub Pages). `vercel.json` here lets it deploy as its own
Vercel project with the project root set to `marketing/`. It is independent of
the application's root `vercel.json` and does not change how the app deploys.

## Screenshots

Every screen image is a real capture of the application, produced by the
harness in [`tools/screenshot-harness`](../tools/screenshot-harness). To
refresh them, run the capture there and then `optimize.mjs`, which writes the
WebP files into `assets/screens/`.

## Content note

All aircraft registrations, crew names, brokers, customers, and passengers on
the page and in the screenshots are fictional, used only for demonstration.
