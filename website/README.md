# doctine.com website

The public website at https://doctine.com: static pages (`index.html`, `about/`, `medical-safety/`, `privacy/`, `terms/`) sharing `assets/site.css` and one header and footer (see `DESIGN.md`). It is separate from the app.

**Sample records:** every "Explore with sample records" / "Sample records" link opens the real app at `https://app.doctine.com/?sample=1`, which goes straight into the app's fictional sample account, so the sample is always the current app. (Until 19 Nov 2026 the website kept its own copy of the app in `app-preview/`, which fell behind; `app-preview/index.html` is now only a redirect for old links. Don't put a copy of the app back here.) `_headers` gives the website the same security headers as the app.

| What | Where |
|---|---|
| Website (this folder) | Cloudflare Pages project `doctine-website` (https://doctine-website.pages.dev), domains `doctine.com` and `www.doctine.com` |
| App, production | Cloudflare Pages project `doctine-app` (production branch `app-release`), domain `app.doctine.com` |
| App, staging | Netlify site `doctine-staging`, https://doctine-staging.netlify.app |

DNS for doctine.com is managed at **Cloudflare** (nameservers `etta.ns.cloudflare.com` and `west.ns.cloudflare.com`, set at Hostinger, where the domain stays registered). `doctine.com` and `www` point to the Cloudflare Pages project (proxied); `app` is a proxied CNAME to the `doctine-app` Pages project; the MX, Google verification and `subdomain-owner-verification` records must stay.

## Updating the website

The website is not built or deployed by the workflows, and app changes don't need a website upload. To publish a website change, run `node tools/build-website.mjs`, then zip the contents of this folder (everything except `README.md`), open Cloudflare → Workers & Pages → `doctine-website` → **Create deployment**, and upload the zip. Cloudflare Pages' free plan allows 500 deploys a month, so publishing the website doesn't use Netlify credits.

Keep the pages honest: describe a feature as available only when it works, label everything else with a status label, make no clinical, regulatory or certification claims, invent no reviews or partners, and keep the safety notice (112, Tele-MANAS 14416) on every page. `tests/browser/website.test.mjs` checks the shared header and footer, links, labels, banned claims and every width from 320px.
