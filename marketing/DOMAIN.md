# `135ops.app` deployment

One Vercel deployment serves two sites, chosen by request host:

| Host | Serves |
|---|---|
| `135ops.app` | the static marketing site in `marketing/` |
| `www.135ops.app` | permanent redirect to `https://135ops.app` |
| the application's own hostname | Skyway Ops, unchanged |

## How the routing works

`npm run build` builds the app to `dist/` and copies this directory to
`dist/marketing/`. Two mechanisms then split traffic by host:

1. **Sub-paths** — a host-scoped rewrite in the root
   [`vercel.json`](../vercel.json) maps `135ops.app/:path*` to
   `/marketing/:path*`.
2. **The homepage** — [`middleware.js`](../middleware.js) rewrites `/` for the
   marketing hosts.

The homepage needs middleware because Vercel evaluates `rewrites` **after** the
filesystem. The application's own `index.html` already matches `/`, so a
host-scoped rewrite for `/` never fires and the marketing domain fell through to
the app's login screen. Middleware runs *before* the filesystem, so it is the
only place that path can be claimed. Its matcher is limited to `/` and
`/index.html`, so no other application route is affected, and any error falls
through to normal app behaviour.

`node tools/middleware.test.mjs` covers the host matching, including that the
app's hostname and lookalike hosts pass through untouched.

## Required Vercel and DNS setup

1. **Attach the domain.** In the Vercel project that deploys this repository,
   open **Settings → Domains** and add `135ops.app` and `www.135ops.app`.
2. **Point DNS at Vercel.** The domain is currently on Cloudflare nameservers
   (`sureena`/`quentin.ns.cloudflare.com`) and proxied. Either keep Cloudflare
   and set the records Vercel shows for the apex and `www`, or use Vercel's own
   records:

   | Name | Type | Value |
   |---|---|---|
   | `@` | `A` | `76.76.21.21` |
   | `www` | `CNAME` | `cname.vercel-dns.com` |

   With the Cloudflare proxy enabled, set SSL/TLS mode to **Full (strict)**.
3. **Serve the current build on the domain.** The domain must be assigned to a
   deployment that contains this directory and the routing above — that is,
   merge this branch to the production branch, or reassign the domain to the
   desired deployment. A domain pinned to an older deployment keeps serving that
   older build.

## Verifying

```bash
curl -sS https://135ops.app/ | grep -o '<title>[^<]*</title>'   # Skyway Ops marketing title
curl -sS -o /dev/null -w '%{http_code}\n' https://135ops.app/styles.css
node tools/screenshot-harness/check-images.mjs https://135ops.app/
```

If a change is not visible, check for CDN caching: Cloudflare sits in front of
Vercel, so purge its cache (or request with a cache-busting query string) before
concluding the deployment is wrong.
