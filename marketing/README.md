# Marketing booklet

`Skyway-Ops-Booklet.pdf` is a nineteen-page product booklet built from
screenshots of the real application, covering the office surfaces and the pilot
phone experience.

## Why there is a preview harness

The app requires a company Microsoft sign-in and live Firebase, Graph and
QuickBooks data, so its screens cannot be opened on a laptop without
credentials. Rather than redraw the interface as a mockup — which would drift
from the product and misrepresent it — the harness in `preview/` mounts the
**actual shipping components** and swaps only the data layer for sample data.

`vite.preview.config.js` does that swap with a resolver scoped to importers
inside `src/`. It is a separate config: `npm run build` never loads it, so
nothing in `preview/` can reach production.

The pilot screens live inside `App.jsx` and cannot be mounted piecemeal, so
`?surface=app` renders the whole application against a stubbed auth module and
`?role=` decides whose experience is shown. That is how the phone captures are
taken.

Every screenshot is therefore a genuine render of the shipping UI. The aircraft
registrations, crew names, brokers, passengers and figures are invented, which
each screenshot page states in its footer.

### Keeping live customer data out

Two things would otherwise put real data in the imagery, and both are closed off
in the harness:

- The app ships a **real JetInsight feed URL** as its default schedule source.
  `preview/fetch-stub.js` answers the app's own `/api/ical` proxy route with a
  fictitious feed in JetInsight's format, and refuses any request whose hostname
  is the live scheduler or a public CORS proxy.
- The app **caches the parsed feed in `localStorage`** and replays it at boot, so
  a browser that once loaded the real feed would keep showing it. `preview/main.jsx`
  clears Skyway's keys and seeds the fictitious feed on every load.

The sample operating day is anchored relative to `now`, so a capture taken at any
hour shows legs already flown, legs airborne and legs still to come.

## Regenerating

```bash
# 1. Serve the real components against sample data
npm run preview:surfaces        # http://127.0.0.1:4178

# 2. Capture every screenshot with a headless browser
npm run marketing:capture

# 3. Trim the captures and rebuild the booklet
npm run marketing:pdf
```

Captures are scripted rather than taken by hand: window chrome,
device-emulation toolbars and DevTools panels all leaked into hand-taken
screenshots. `scripts/capture-marketing-shots.mjs` drives the surfaces, walks
the pilot's own navigation for the phone screens, and shoots individual cards as
elements so they keep the type sizes they were designed at.

`marketing/raw2/` is untracked because it holds the untrimmed captures.
`marketing/shots/` holds the images the booklet embeds and is tracked, so the
document can be rebuilt without recapturing.

If a stub falls behind the module it stands in for, a screen fails to import a
binding and renders blank at runtime rather than failing the build.
`node scripts/check-preview-stubs.mjs` catches that by comparing each stub
against its real module's export surface.

## Surfaces

| `?surface=` | Screen |
| --- | --- |
| `app` | The whole application, signed in; combine with `?role=crew` or `?role=admin` |
| `dashboard` | Operations control dashboard |
| `dispatch` | Ops console / flight control |
| `board` | Full-screen flight board |
| `duty` | Crew duty and rest |
| `dutyreport` | Administrator duty reporting |
| `expenses` | Expense reconciliation |
| `broker` | Broker-facing live tracking link |
| `email` | Company mail |
| `teams` | Microsoft Teams |
| `accounting` | Invoices and receivables |

## Contents

| Page | Subject |
| --- | --- |
| 1 | Cover |
| 2 | How it works — one operating day |
| 3 | Live fleet tracking |
| 4 | The operations dashboard |
| 5 | Crew on duty, PIC and SIC grouped |
| 6 | Dispatch flight control |
| 7 | The schedule, leg by leg |
| 8 | Pilot phone — home and schedule |
| 9 | Pilot phone — trip milestones |
| 10 | Passenger manifests and check-in |
| 11 | Duty and rest on the phone |
| 12 | Duty compliance reporting |
| 13 | Crew expense capture |
| 14 | Expense reconciliation |
| 15 | Broker live tracking link |
| 16 | Company email |
| 17 | Microsoft Teams |
| 18 | Invoices and receivables |
| 19 | Closing summary |
