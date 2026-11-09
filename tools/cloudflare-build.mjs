/**
 * Doctine · build step for Cloudflare Pages. Stamps the commit this deploy serves (public/version.json, used by the smoke
 * check) and writes public/_headers with the same security headers as netlify.toml. Runs the server tests first, like
 * the Netlify build, so a broken commit never deploys. Cloudflare provides CF_PAGES_COMMIT_SHA.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["tests/functions.test.mjs"], { stdio: "inherit" });
const sha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || "";
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("no commit id to stamp (CF_PAGES_COMMIT_SHA)");
writeFileSync("public/version.json", JSON.stringify({ commit: sha }) + "\n");
// Scripts only from this site and the two libraries' CDNs. This also keeps out anything a host injects into pages, such
// as an analytics beacon: the privacy policy says Doctine collects no analytics.
const CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
writeFileSync("public/_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: ${CSP}
  X-Robots-Tag: noindex, nofollow
/api/*
  Cache-Control: no-store
/version.json
  Cache-Control: no-store
/vendor/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=2592000
`);
console.log("cloudflare-build: stamped " + sha.slice(0, 12) + " and wrote _headers");
