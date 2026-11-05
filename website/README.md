# doctine.com website

The public website at https://doctine.com: static pages (`index.html`, `about/`, `medical-safety/`, `privacy/`, `terms/`) sharing `assets/site.css` and one header and footer (see `DESIGN.md`), plus `app-preview/`, a clickable preview of the app with fictional sample data. It is separate from the app.

`app-preview/index.html` is generated from `public/index.html` by `node tools/build-preview.mjs` (do not edit it by hand). The preview opens straight into sample data, leaves out Reminders and Family, answers every `/api/*` request inside the browser (so chat and the scanner are switched off and nothing is sent or saved) and registers no service worker. CI fails if the preview is out of date with the app, and `tests/browser/preview.test.mjs` checks the preview in a browser. `_headers` gives the website the same security headers as the app.

| What | Where |
|---|---|
| Website (this folder) | Cloudflare Pages project `doctine-website` (https://doctine-website.pages.dev), domains `doctine.com` and `www.doctine.com` |
| App, production | Cloudflare Pages project `doctine-app` (production branch `app-release`), domain `app.doctine.com` |
| App, staging | Netlify site `doctine-staging`, https://doctine-staging.netlify.app |

DNS for doctine.com is managed at **Cloudflare** (nameservers `etta.ns.cloudflare.com` and `west.ns.cloudflare.com`, set at Hostinger, where the domain stays registered). `doctine.com` and `www` point to the Cloudflare Pages project (proxied); `app` is a proxied CNAME to the `doctine-app` Pages project; the MX, Google verification and `subdomain-owner-verification` records must stay.

## Updating the website

The website is not built or deployed by the workflows. After changing the app, run `node tools/build-preview.mjs`. To publish, zip the contents of this folder (everything except `README.md`), open Cloudflare → Workers & Pages → `doctine-website` → **Create deployment**, and upload the zip. Cloudflare Pages' free plan allows 500 deploys a month, so publishing the website doesn't use Netlify credits.

Keep the pages honest: describe a feature as available only when it works, label everything else with a status label, make no clinical, regulatory or certification claims, invent no reviews or partners, and keep the safety notice (112, Tele-MANAS 14416) on every page. `tests/browser/website.test.mjs` checks the shared header and footer, links, labels, banned claims and every width from 320px.
