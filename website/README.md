# doctine.com website

The public website at https://doctine.com: a static page about Doctine, plus `app-preview/`, a clickable preview of the app with fictional sample data. It is separate from the app.

`app-preview/index.html` is generated from `public/index.html` by `node tools/build-preview.mjs` (do not edit it by hand). The preview opens straight into sample data, leaves out Reminders and Family, answers every `/api/*` request inside the browser (so chat and the scanner are switched off and nothing is sent or saved) and registers no service worker. CI fails if the preview is out of date with the app.

| What | Where |
|---|---|
| Website (this folder) | Netlify site `dancing-licorice-19e837`, domains `doctine.com` and `www.doctine.com` |
| App, production | Netlify site `stately-macaron-a8b141`, domain `app.doctine.com` (a "coming soon" placeholder until the first release) |
| App, staging | Netlify site `doctine-staging`, https://doctine-staging.netlify.app |

DNS for doctine.com is managed at Hostinger: `A @ 75.2.60.5` and `CNAME www` point to the website, and `CNAME app` points to the production app site. The MX and Google verification records are for email and must stay.

## Updating the website

The website is not built or deployed by the workflows. After changing the app, run `node tools/build-preview.mjs`. To publish, zip the contents of this folder (`index.html` and `app-preview/`), open the website's Netlify site → Deploys, and drop the zip onto the upload area.

Keep the page honest: no clinical claims, no invented reviews, and keep the safety notice (112, Tele-MANAS 14416).
