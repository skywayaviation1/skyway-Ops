# Google Maps for Tracking Maps

Google Maps is the preferred basemap for every Skyway tracking surface:

- Operations Tracking;
- public broker tracking;
- brokered operator crew tracking;
- the operations dashboard fleet map;
- the TV Flight Board.

Leaflet remains a transparent operational layer above Google Maps for aircraft,
routes, trails, airport markers, fitting, and weather radar. If Google Maps is
not configured or rejects the deployment, the app tries Apple MapKit and then
the existing standard tiles.

## Google Cloud setup

1. Open the Google Cloud Console and select or create the Skyway project.
2. Attach a billing account. Google Maps will not render without billing.
3. Open **APIs & Services → Library** and enable **Maps JavaScript API**.
4. Open **APIs & Services → Credentials** and create an API key.
5. Under **Application restrictions**, choose **Websites**.
6. Add the exact production referrers:
   - `https://skyway.app/*`
   - `https://www.skyway.app/*` if that hostname is also used
7. Add a preview referrer only if Google Maps should work on that preview.
8. Under **API restrictions**, choose **Restrict key** and allow only
   **Maps JavaScript API**.

The browser receives this key as required by Google Maps. HTTP-referrer and API
restrictions, not secrecy, protect a browser Maps key.

## Vercel environment

Add the key as a server environment variable:

| Variable | Meaning |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Referrer-restricted Maps JavaScript API key |

Set it for Production and any intended Preview environment, then redeploy.
Do not use `VITE_*`; `/api/google-maps-config` delivers the deployment-specific
key only when a tracking map mounts.

## Verify

1. Open `https://skyway.app/api/google-maps-config`.
2. A configured deployment returns HTTP 200 with `"configured": true`.
3. Open Operations Tracking and its layer menu.
4. The choices should read **Google Roadmap**, **Google Satellite**, and
   **Google Hybrid**.
5. The TV Flight Board displays a **GOOGLE MAPS** badge.

If the endpoint returns 503, the key is absent in that Vercel environment or
the deployment predates the environment change. If the map displays Google's
authorization error, verify billing, Maps JavaScript API enablement, and the
exact HTTP referrer restriction.

