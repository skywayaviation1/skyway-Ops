# `135ops.app` cutover

The marketing website belongs in its own repository and Vercel project. This
keeps it out of the operations app's build, middleware and deployment paths:
publishing marketing copy cannot affect sign-in or flight operations, and an app
release cannot replace the marketing homepage with the login screen.

## Cutover order

1. Create a private GitHub repository named `135ops-marketing` and put the
   contents of this directory at its root.
2. Import that repository as a **new Vercel project**. Use no framework preset,
   no build command and no output directory — this is a static site.
3. Verify the Vercel preview URL:

   ```bash
   npm test
   curl -sS "$PREVIEW_URL/" | grep -o '<title>[^<]*</title>'
   ```

4. In the **existing app project**, remove `135ops.app` and
   `www.135ops.app` under **Settings → Domains**.
5. Immediately add both domains to the **new marketing project**. Keeping this
   order avoids Vercel's “domain is already assigned to another project”
   refusal.
6. The domain is currently on Cloudflare nameservers
   (`sureena`/`quentin.ns.cloudflare.com`) and proxied. Either keep Cloudflare
   and set the records Vercel shows for the apex and `www`, or use Vercel's own
   records:

   | Name | Type | Value |
   |---|---|---|
   | `@` | `A` | `76.76.21.21` |
   | `www` | `CNAME` | `cname.vercel-dns.com` |

   With the Cloudflare proxy enabled, set SSL/TLS mode to **Full (strict)**.
7. Purge the Cloudflare cache after Vercel reports **Valid Configuration** for
   both domains.

This branch has already removed the experimental marketing middleware,
postbuild copy, dependency, and host rewrites from the app. Do not merge that
app-side cleanup until the standalone preview is verified and the domain
cutover is ready; the current production app deployment remains unchanged while
the branch is open.

## Verifying

```bash
curl -sS https://135ops.app/ | grep -o '<title>[^<]*</title>'   # Skyway Ops marketing title
curl -sS -o /dev/null -w '%{http_code}\n' https://135ops.app/styles.css
npm test
```

If a change is not visible, check for CDN caching: Cloudflare sits in front of
Vercel, so purge its cache (or request with a cache-busting query string) before
concluding the deployment is wrong.
