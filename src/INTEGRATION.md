# Trip Hotels Module — Integration & Deployment Guide

This module adds hotel booking management to Skyway Ops. Pilots, ops, and admin
can book Marriott direct (pilots keep points/elite nights) or Expedia TAAP
(Skyway earns commission), side-by-side per overnight.

---

## Files to add

Two new files. Copy each into the repo via GitHub web UI ("Add file → Create new file").

1. **`src/firebase-hotels.js`** — Firestore module (matches your existing
   `firebase-customers.js` / `firebase-aircraft.js` style).
2. **`src/screens/TripHotels.jsx`** — the screen component.

> If `src/screens/` doesn't exist yet, GitHub will create it for you when you
> type `src/screens/TripHotels.jsx` as the file name.

---

## App.jsx integration (3 small edits)

### Edit 1: Import the screen at the top of `App.jsx`

Find the section near the top of `App.jsx` where other imports live (look for
the block with `import React, …` and the various `firebase-*` imports). Add
this line:

```jsx
import TripHotels from "./screens/TripHotels";
```

### Edit 2: Add a route/view state for the hotels screen

Skyway Ops uses an internal view-state pattern (not React Router) based on
what we've worked on previously. Find where you handle the trip detail view —
typically a state value like `activeView === "trip-detail"` or similar.

Add a new view value, e.g. `"trip-hotels"`, and render the component when
that view is active. Example pattern (adapt to your actual state shape):

```jsx
{activeView === "trip-hotels" && selectedTrip && (
  <TripHotels
    trip={selectedTrip}
    currentUser={currentUser}
    crewOnTrip={crewForTrip(selectedTrip)}
    onClose={() => setActiveView("trip-detail")}
  />
)}
```

Where:
- `selectedTrip` is whatever state variable already holds the currently-viewed trip.
- `currentUser` is your existing logged-in user object — must include `id`,
  `name`, and `role` (one of `"pilot" | "sales" | "ops" | "admin"`).
- `crewForTrip(trip)` is a helper that returns the array of crew members
  assigned to the trip. If you don't have this exact helper, build the array
  from whatever crew-assignment state you already keep. Each entry needs
  `{ id, name, role }`.

### Edit 3: Add a "Hotels" button on the trip detail view

In whatever component renders the trip detail screen (likely a section in
`App.jsx` near the trip view code), add a button to switch to the hotels view:

```jsx
<button
  onClick={() => setActiveView("trip-hotels")}
  style={{
    padding: "8px 14px",
    background: "#1F3A5F",
    color: "#FFFFFF",
    border: "none",
    borderRadius: 6,
    fontWeight: 600,
    cursor: "pointer",
  }}
>
  🏨 Hotels
</button>
```

Place it next to other trip-action buttons (Manifest, Expenses, etc.).

---

## Trip data shape — what the screen expects

The `TripHotels` component reads these fields off the `trip` prop:

```
trip = {
  id: string,
  tailNumber?: string,       // optional, shown in header
  crewIds?: string[],        // optional, fallback if leg has no crewIds
  legs: [
    {
      id: string,
      arrivalAirport: string,    // e.g. "TEB"
      departureAirport: string,
      arrivalDate: string,       // ISO "YYYY-MM-DD" or full ISO datetime
      departureDate: string,
      isOvernight?: boolean,     // optional explicit flag
      cityLabel?: string,        // optional pretty city name
      crewIds?: string[],
    }
  ]
}
```

If your trip object uses different field names (e.g. `tail` vs `tailNumber`,
or legs are stored under a different key), open `TripHotels.jsx` and adjust
the `deriveOvernights()` function near the bottom — it's the only place
trip-shape assumptions live.

If you tell me the actual shape of `selectedTrip` in your `App.jsx`, I can
patch `deriveOvernights()` to match exactly.

---

## Firestore — no schema work needed

The module writes to a new collection: `tripHotelBookings`.

Firestore creates collections lazily on first write, so no manual setup is
required. If you have Firestore security rules configured, you may need to
add a rule for the new collection. A safe starting rule (matches your
existing role-based pattern):

```
match /tripHotelBookings/{docId} {
  allow read: if request.auth != null;
  allow write: if request.auth != null;
}
```

If you want stricter rules (only crew-on-trip can write), let me know and I'll
draft those — but they need to match how you currently scope writes on other
collections.

---

## Configuration — two values to update later

Inside `src/firebase-hotels.js` near the bottom, two constants control
external URLs:

```js
export const SKYWAY_CORPORATE_CODE = ""; // empty for now
export const SKYWAY_TAAP_PORTAL_URL = "https://www.expedia.com/affiliates";
```

- **`SKYWAY_CORPORATE_CODE`** — leave empty until your Marriott Bonvoy for
  Business application is approved. Then replace with the corporate code
  Marriott assigns you (a short alphanumeric string). The deep-link works
  without it; it just won't apply the negotiated rate.
- **`SKYWAY_TAAP_PORTAL_URL`** — replace with your actual TAAP agent portal
  URL once your IATAN/TAAP setup gives you a stable affiliate URL.

When you update either of these, commit the change and Vercel will redeploy
automatically.

---

## Step-by-step: deploying via GitHub web UI

1. Go to https://github.com/skywayaviation1/skyway-Ops
2. Click **Add file → Create new file**
3. In the filename box, type: `src/firebase-hotels.js`
4. Paste the full contents of `firebase-hotels.js`
5. Scroll down, write commit message: `Add hotel bookings Firestore module`
6. Click **Commit new file**
7. Repeat for `src/screens/TripHotels.jsx` (commit message: `Add Trip Hotels screen`)
8. Edit `src/App.jsx`:
   - Open `src/App.jsx`, click the pencil icon to edit
   - Add the import line at the top
   - Add the view block and the Hotels button as described above
   - Commit message: `Wire up Trip Hotels screen`
9. Vercel will auto-deploy in ~60 seconds. Check skyway-ops.vercel.app.

---

## What to test after deploy

1. Open an upcoming trip with at least one overnight.
2. Click the new **🏨 Hotels** button.
3. Verify a card appears for each overnight with the right dates.
4. Click **Marriott Direct** — should open marriott.com pre-filled with
   destination and dates.
5. Click **Expedia TAAP** — should open the TAAP placeholder URL.
6. Click **+ Enter Confirmation** as a pilot or ops/admin, fill the form,
   save. Confirm it appears in the bookings list and the card flips to
   "Booked" status.
7. As ops/admin, try **Mark not needed** with a reason — confirm the card
   shows as opted out and can be reopened.
8. Open Firebase console → Firestore → check that documents appear in
   `tripHotelBookings`.

---

## Known follow-ups (not blocking)

- **Expense flow integration:** Right now bookings live in their own
  collection. Wiring them into your existing expenses screen (so a confirmed
  booking auto-creates an expense line) is a 30-minute follow-up — say the
  word and I'll patch it.
- **Receipt upload:** The data model has a slot for `receiptUrl` per booking
  but the UI doesn't expose it yet. Easy to add once you decide whether
  receipts live in Firebase Storage or get linked from the expense flow.
- **Marriott corporate code:** Apply at
  https://www.marriott.com/loyalty/business — typical approval is 1-2 weeks.
- **Aviation crew rate alternative:** If the corporate program is slow,
  Marriott also has a "Crew Rate" program specifically for Part 135/121
  operators that flight departments use. Worth asking about during the
  application call.
