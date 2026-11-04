# doctine.com website

The public website at https://doctine.com: a single static page about Doctine. It is separate from the app.

| What | Where |
|---|---|
| Website (this folder) | Netlify site `dancing-licorice-19e837`, domains `doctine.com` and `www.doctine.com` |
| App, production | Netlify site `stately-macaron-a8b141`, domain `app.doctine.com` (a "coming soon" placeholder until the first release) |
| App, staging | Netlify site `doctine-staging`, https://doctine-staging.netlify.app |

DNS for doctine.com is managed at Hostinger: `A @ 75.2.60.5` and `CNAME www` point to the website, and `CNAME app` points to the production app site. The MX and Google verification records are for email and must stay.

## Updating the website

The website is not built or deployed by the workflows. To publish a change, open the website's Netlify site → Deploys, and drag this folder's `index.html` onto the upload area.

Keep the page honest: no clinical claims, no invented reviews, and keep the safety notice (112, Tele-MANAS 14416).
