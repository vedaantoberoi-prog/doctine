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
writeFileSync("public/_headers", `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains
/api/*
  Cache-Control: no-store
/version.json
  Cache-Control: no-store
`);
console.log("cloudflare-build: stamped " + sha.slice(0, 12) + " and wrote _headers");
