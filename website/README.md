# doctine.com website

The public website at https://doctine.com: a static page about Doctine, plus `app-preview/`, a clickable preview of the app with fictional sample data. It is separate from the app.

`app-preview/index.html` is generated from `public/index.html` by `node tools/build-preview.mjs` (do not edit it by hand). The preview opens straight into sample data, leaves out Reminders and Family, answers every `/api/*` request inside the browser (so chat and the scanner are switched off and nothing is sent or saved) and registers no service worker. CI fails if the preview is out of date with the app, and `tests/browser/preview.test.mjs` checks the preview in a browser. `_headers` gives the website the same security headers as the app.

| What | Where |
|---|---|
| Website (this folder) | Cloudflare Pages project `doctine-website` (https://doctine-website.pages.dev), domains `doctine.com` and `www.doctine.com` |
| App, production | Netlify site `stately-macaron-a8b141`, domain `app.doctine.com` (a "coming soon" placeholder until the first release) |
| App, staging | Netlify site `doctine-staging`, https://doctine-staging.netlify.app |

DNS for doctine.com is managed at **Cloudflare** (nameservers `etta.ns.cloudflare.com` and `west.ns.cloudflare.com`, set at Hostinger, where the domain stays registered). `doctine.com` and `www` point to the Cloudflare Pages project (proxied); `app` is a DNS-only CNAME to the production Netlify site (keep it DNS-only so Netlify can renew its certificate); the MX, Google verification and `subdomain-owner-verification` records must stay.

## Updating the website

The website is not built or deployed by the workflows. After changing the app, run `node tools/build-preview.mjs`. To publish, zip the contents of this folder (`index.html`, `_headers`, `privacy/`, `terms/` and `app-preview/`), open Cloudflare → Workers & Pages → `doctine-website` → **Create deployment**, and upload the zip. Cloudflare Pages' free plan allows 500 deploys a month, so publishing the website doesn't use Netlify credits.

Keep the page honest: no clinical claims, no invented reviews, and keep the safety notice (112, Tele-MANAS 14416).
