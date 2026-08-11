# Marketing overview PDF

`Skyway-Ops-Overview.pdf` is a ten-page product overview built from screenshots
of the real application.

## Why there is a preview harness

The app requires a company Microsoft sign-in and live Firebase/Graph/QuickBooks
data, so its screens cannot be opened on a laptop without credentials. Rather
than redraw the interface as a mockup — which would drift from the product and
misrepresent it — the harness in `preview/` mounts the **actual shipping
components** and swaps only the Firebase data modules for sample data.

`vite.preview.config.js` does that swap with a resolver that is scoped to
importers inside `src/`. It is a separate config: `npm run build` never loads it,
so nothing in `preview/` can reach production.

Every screenshot is therefore a genuine render of the shipping UI. The aircraft
registrations, crew names, brokers, passengers and dollar figures are invented,
which each screenshot page states in its footer.

## Regenerating

```bash
# 1. Serve the real components against sample data
npm run preview:surfaces        # http://127.0.0.1:4178

#    Surfaces: ?surface=dashboard | email | teams | accounting

# 2. Capture 1600x1000 browser screenshots into marketing/raw/
#    (dashboard.png, boards.png, email-open.png, teams-channel.png,
#     accounting-all.png — interact first where a panel needs a selection)

# 3. Crop chrome/dead space and rebuild the PDF
npm run marketing:pdf
```

`marketing/raw/` is untracked because it holds untrimmed captures including
browser chrome. `marketing/shots/` holds the cropped images the PDF embeds and
is tracked so the document can be rebuilt without recapturing.

## Contents

| Page | Subject |
| --- | --- |
| 1 | Cover |
| 2 | How it works — one operating day |
| 3 | Live fleet tracking |
| 4 | Today's flight board |
| 5 | Pilots currently on duty |
| 6 | Company email |
| 7 | Microsoft Teams |
| 8 | Accounting and receivables |
| 9 | Platform, roles and compliance |
| 10 | Closing summary |
