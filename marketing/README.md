# Marketing booklets

Two nineteen-page documents are produced from the same pipeline:

| File | Operator | Purpose |
| --- | --- | --- |
| `Skyway-Ops-Booklet.pdf` | Skyway Aviation | The operator's own product booklet |
| `Elite-Jets-Operations-Preview.pdf` | Elite Jets | A branded preview for a prospective tenant |

Both cover the office surfaces and the pilot phone experience, and both are
screenshots of the real application.

## Tenant branding is a real capability, not a skin

The second booklet is not a mockup with a logo pasted on. `src/brand.js` declares
each operator's wordmark, accent ink and the identity a broker sees, and the app
resolves it from `VITE_TENANT` at build time. The accent already resolved through
one CSS variable, so a tenant re-accents the entire product. That means the
Elite Jets screenshots are the shipping application genuinely running as Elite
Jets, which is what makes them honest to put in front of a prospect.

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
`?surface=app` renders the whole application against a stubbed auth module, and
`?role=` decides whose experience is shown. That is how the phone captures are
taken.

Every screenshot is therefore a genuine render of the shipping UI. The aircraft
registrations, crew names, brokers, passengers and figures are invented, which
each screenshot page states in its footer.

### The sample operation

`preview/tenants.js` declares each operator's fleet, crew, staff, customers,
passengers and operating day. Everything else — the schedule feed, live
positions, duty records, trip milestones, expenses, and the mail, Teams,
QuickBooks and broker payloads — derives from it, so nothing in the harness
names an operator and adding one is a data change.

The day is anchored relative to `now`, so a capture taken at any hour shows legs
already flown, legs airborne and legs still to come.

### Keeping live customer data out

Two things would otherwise put real data in the imagery, and both are closed off:

- The app ships a **real JetInsight feed URL** as its default schedule source.
  `preview/fetch-stub.js` answers the app's own `/api/ical` proxy route with a
  fictitious feed in JetInsight's format, and refuses any request whose hostname
  is the live scheduler or a public CORS proxy.
- The app **caches the parsed feed in `localStorage`** and replays it at boot, so
  a browser that once loaded the real feed would keep showing it. `preview/main.jsx`
  clears the app's keys and seeds the fictitious feed on every load.

## Regenerating

```bash
# 1. Serve the real components against sample data
npm run preview:surfaces        # http://127.0.0.1:4178

# 2. Capture every screenshot, then build the booklet, per operator
TENANT=skyway npm run marketing:capture && TENANT=skyway npm run marketing:pdf
TENANT=elite  npm run marketing:capture && TENANT=elite  npm run marketing:pdf
```

`TENANT` defaults to `skyway`. Captures land in `marketing/raw2/<tenant>/`
(untracked) and prepared images in `marketing/shots/<tenant>/` (tracked), so a
booklet can be rebuilt without recapturing.

Captures are scripted rather than taken by hand: window chrome,
device-emulation toolbars and DevTools panels all leaked into hand-taken
screenshots. `scripts/capture-marketing-shots.mjs` drives the surfaces, walks
the pilot's own navigation for the phone screens, and shoots individual cards as
elements so they keep the type sizes they were designed at.

`npm run preview:stubs` compares each stub against its real module's export
surface, because a missing binding blanks a screen at runtime rather than
failing the build.

The Elite Jets wordmark is vector art rendered by `npm run logo:elite`, not a
checked-in binary, so the lockup can be adjusted and regenerated.

## Surfaces

Append `&tenant=elite` to any of these to see it as the other operator.

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
