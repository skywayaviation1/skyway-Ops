# Apple Maps for Tracking Maps

Skyway tracking maps use Apple's official MapKit JS renderer for the basemap.
Leaflet remains a transparent operational overlay for aircraft markers, flown
trails, routes, airport labels, weather radar, fitting, and map interaction.
This preserves the existing tracking features without downloading, extracting,
or repackaging Apple map tiles.

If Apple Maps is not configured, its token is rejected, its CDN is
unavailable, or its tiles do not paint, the Apple layer stays hidden and the
component uses Google Maps when `GOOGLE_MAPS_API_KEY` is set (see
`docs/google-maps-setup.md`), then Esri / OpenTopoMap tiles. Standard tiles
are drawn first, so a MapKit failure never leaves the unloaded cream grid on
screen. CARTO dark/light rasters were checked again on 2026-09-28 and still
watermark "API KEY REQUIRED" without a key, so the street fallback is Esri
World Dark Gray in the dark theme and Esri World Light Gray in the light
theme. Aircraft position and status data are never dependent on Apple or Google.

## Apple Developer setup

In Certificates, Identifiers & Profiles:

1. Create or select a **Maps ID** for the Skyway web application.
2. Configure every domain that should render Apple tiles:
   `skyway.app`, `www.skyway.app`, `135ops.app`, `www.135ops.app`, and
   preview hosts (`*.vercel.app` when the portal accepts a wildcard, otherwise
   each preview hostname). Apple does not accept `capacitor://localhost`.
3. Create a **MapKit JS Maps token**, choose a domain restriction, and enter
   those same website domains. A portal token cannot authorize the native app.
4. Copy the generated JWT. Portal-generated domain tokens may intentionally
   have no `exp` claim when **No Expiration** is selected; the domain restriction
   prevents use elsewhere.

## Server environment

Set these values for every deployment environment that should render Apple
Maps, then redeploy:

| Variable | Meaning |
| --- | --- |
| `APPLE_MAPKIT_TOKEN` | Preferred. The portal-generated MapKit JS token with `scope: mapkit_js` and an allowed domain matching this deployment |
| `APPLE_MAPKIT_TEAM_ID` | Alternative dynamic signing: Apple Developer Team ID |
| `APPLE_MAPKIT_KEY_ID` | Alternative dynamic signing: MapKit key ID |
| `APPLE_MAPKIT_PRIVATE_KEY` | Alternative dynamic signing: complete `.p8` private key. Literal newlines or escaped `\\n` are accepted |
| `APPLE_MAPKIT_ORIGIN` | Optional extra allowed origin, used only when the request has no allowlisted Origin, Referer, or Host. It does not override the caller's real origin. Unset it when it was previously forcing every caller onto one website |

Never use `VITE_*` for these values. A Vite-prefixed value is compiled into
public browser JavaScript.

`/api/apple-mapkit-token` validates the supplied token's ES256 algorithm,
`mapkit_js` scope, and allowed domain before returning it. The allowlist is
`skyway.app`, `www.skyway.app`, `135ops.app`, `www.135ops.app`, `*.vercel.app`,
localhost, `capacitor://localhost`, and `https://localhost`, plus
`APPLE_MAPKIT_ORIGIN` when that is set. A token restricted to `skyway.app`
is not returned for a different host. When the `.p8` signing variables are
set, that host gets its own short-lived token instead. Native WebViews
(`capacitor://localhost` on iOS, `https://localhost` on Android) always get a
dynamically signed token with **no origin claim**, because a website-locked
portal token is what leaves MapKit's cream grid up in the app. That requires
`APPLE_MAPKIT_TEAM_ID`, `APPLE_MAPKIT_KEY_ID`, and `APPLE_MAPKIT_PRIVATE_KEY`.
Without them the native app skips Apple and draws Esri tiles.

When using the `.p8` setup, the endpoint signs an ES256 JWT that:

- contains only Team ID, Key ID, `mapkit_js` scope, issue/expiry times, and,
  for websites, the requesting origin (native tokens omit the origin claim);
- is valid for 15 minutes;
- is restricted to the requesting website origin, or unrestricted for the
  native WebView;
- is delivered to MapKit JS while the `.p8` key remains server-only.

MapKit JS may request a replacement token automatically before expiry.

## Maps affected

`src/TrackingMap.jsx` is shared by:

- Operations Tracking;
- public broker tracking links;
- the brokered operator crew portal;
- the operations dashboard fleet map.

Those surfaces switch together. The separate TV Flight Board renderer also
uses Apple Hybrid imagery while retaining its existing route, aircraft, and
weather-radar overlays.

## Map choices

The existing layer menu maps to Apple Standard / Satellite / Hybrid when
MapKit is active. If Apple is unavailable and Google Maps is configured,
the same three slots become Google Roadmap / Satellite / Hybrid. The last
resort tile fallback is Esri Dark or Light Gray (matching the theme) /
Esri Satellite / OpenTopoMap. The Apple container stays hidden until MapKit
reports that the base map painted. A token error, an auth error (including
one that fires before the map listener is attached), or no tiles within a
few seconds hides Apple and leaves the standard tiles in place.

Weather radar and flight trails continue to render above all three.

