# Apple Maps for Tracking Maps

Skyway tracking maps use Apple's official MapKit JS renderer for the basemap.
Leaflet remains a transparent operational overlay for aircraft markers, flown
trails, routes, airport labels, weather radar, fitting, and map interaction.
This preserves the existing tracking features without downloading, extracting,
or repackaging Apple map tiles.

If Apple Maps is not configured, its token is rejected, or its CDN is
unavailable, the component automatically falls back to the existing standard
basemap. Aircraft position and status data are never dependent on Apple.

## Apple Developer setup

In Certificates, Identifiers & Profiles:

1. Create or select a **Maps ID** for the Skyway web application.
2. Configure the production domain and any preview domains Apple should allow.
3. Create a **MapKit JS key** associated with that Maps ID.
4. Download its `.p8` private key. Apple only permits downloading it once.

## Server environment

Set these values for every deployment environment that should render Apple
Maps, then redeploy:

| Variable | Meaning |
| --- | --- |
| `APPLE_MAPKIT_TEAM_ID` | Apple Developer Team ID |
| `APPLE_MAPKIT_KEY_ID` | MapKit JS key ID |
| `APPLE_MAPKIT_PRIVATE_KEY` | Complete `.p8` private key. Literal newlines or escaped `\\n` are accepted |
| `APPLE_MAPKIT_ORIGIN` | Optional fixed allowed origin, for example `https://ops.example.com`. When omitted, the request's forwarded host/protocol is used |

Never use `VITE_*` for these values. A Vite-prefixed value is compiled into
public browser JavaScript.

`/api/apple-mapkit-token` signs an ES256 JWT that:

- contains only Team ID, Key ID, issue/expiry times, and request origin;
- is valid for 15 minutes;
- is restricted to the requesting origin;
- is delivered to MapKit JS while the `.p8` key remains server-only.

MapKit JS may request a replacement token automatically before expiry.

## Maps affected

`src/TrackingMap.jsx` is shared by:

- Operations Tracking;
- public broker tracking links;
- the operations dashboard fleet map.

Those surfaces switch together. The separate TV Flight Board map has its own
renderer and is not changed by this integration.

## Map choices

The existing layer menu maps to:

- **Apple Standard**
- **Apple Satellite**
- **Apple Hybrid**

Weather radar and flight trails continue to render above all three.

