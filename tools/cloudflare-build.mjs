// Doctine · retired Cloudflare Pages project "doctine-app" (doctine-app.pages.dev). The app moved to app.doctine.com
// (project doctine-app-direct). This branch only serves a page pointing there, with no server code and no keys, so the
// old address can't be claimed by anyone else and no outdated copy of the app stays online.
import { writeFileSync } from "node:fs";
writeFileSync("public/_headers", `/*
  X-Robots-Tag: noindex, nofollow
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`);
console.log("retired: serving the redirect page only");
