# `135ops.app` deployment

The repository's root Vercel deployment now serves two sites from one build:

- requests whose host is `135ops.app` serve the static marketing site;
- the existing Vercel/app hostname continues to serve Skyway Ops;
- `www.135ops.app` redirects permanently to `https://135ops.app`.

`npm run build` copies this directory into `dist/marketing`, and the host-based
rules in the root [`vercel.json`](../vercel.json) route the custom domain there.

## One-time Vercel and DNS setup

1. In the Vercel project currently deploying this repository, open
   **Settings → Domains**.
2. Add `135ops.app` and `www.135ops.app`.
3. At the domain's DNS provider, add the records Vercel displays. Unless
   Vercel requests project-specific verification records, its standard records
   are:

   | Name | Type | Value |
   |---|---|---|
   | `@` | `A` | `76.76.21.21` |
   | `www` | `CNAME` | `cname.vercel-dns.com` |

4. Remove conflicting `A`, `AAAA`, or `CNAME` records for the same names.
5. Wait for both domains to show **Valid Configuration** in Vercel. Vercel
   provisions the TLS certificate automatically.

The domain currently returns no authoritative DNS records, so these external
steps are required before the site can resolve publicly.
