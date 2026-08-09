# Screenshot harness

Renders the **real** Skyway Ops screens from `src/` against an in-memory dataset
and captures the images used on the marketing site. Nothing in `src/` is
modified or stubbed: only the Firebase SDK and the `/api` endpoints are swapped
for stand-ins, so every screen runs its own components, styling, formatting and
business logic — including the Part 135 legality engine.

## How it works

| Piece | Role |
|---|---|
| `mock/firestore.js` | In-memory Firestore: collections, queries, `onSnapshot`, batches |
| `mock/auth.js` | Signs in a fixed `@flyskyway.com` identity (ops/admin, or a pilot with `?as=crew`) |
| `mock/storage.js`, `mock/app.js`, `mock/messaging.js` | Remaining SDK surface |
| `api-mock.js` | Vite middleware answering `/api/ical`, weather, NOTAMs, FlightAware positions, broker tracking |
| `clock.js` | Pins "now" to today at 14:22 local so captures are reproducible |
| `data/` | The demo flight department: roster, fleet, schedule, positions |
| `seed.js` | Seeds the dataset, calling the app's own write functions where they exist |
| `capture.mjs` | Drives headless Chrome through the screens and writes PNGs |
| `optimize.mjs` | Converts the PNGs to web-sized WebP (the committed form) |

All demo names, tails, customers and passengers are fictional.

## Running it

Dependencies: the repo's own `npm install`, plus `npm install` inside this
directory (for `puppeteer-core`). Chrome is expected at
`/usr/local/bin/google-chrome`.

```bash
# terminal 1 — the harness must run in Eastern time so the schedule reads as ET
TZ=America/New_York npx vite --config tools/screenshot-harness/vite.config.mjs

# terminal 2
cd tools/screenshot-harness
node capture.mjs              # everything, or: node capture.mjs command-center duty-rest
node optimize.mjs             # PNG -> WebP into marketing/assets/screens/
```

Useful while iterating:

```bash
node debug.mjs                # load once, print console output and page text
node probe.mjs "Crew>Duty"    # click a nav path, then list clickable labels
```

## Notes

- Tabs listen for pointer events (they support long-press reordering), so the
  capture script drives the real mouse rather than calling `.click()`.
- Comms is not captured: it runs on Stream Chat, which has no local stand-in.
- `?view=broker` renders the public broker tracking page; `?as=crew` renders a
  pilot's own view of the app.
