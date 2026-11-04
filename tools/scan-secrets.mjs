/**
 * Doctine · basic secret scan of the working tree (CI also runs gitleaks over the git history).
 * Prints only the file, line number and kind of secret, never the value.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", ".git", "reports", "test-results", "playwright-report"]);
const walk = (d) => readdirSync(d).flatMap((f) => (skip.has(f) ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const RULES = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["JSON Web Token (e.g. a Supabase key)", /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{20,}/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Netlify token", /\bnfp_[A-Za-z0-9]{30,}\b/],
  // A literal value (quoted, or a dotenv-style KEY=value line). References such as process.env.X are not values.
  ["Secret assigned in a file", /\b(ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|RATE_LIMIT_SECRET|EVAL_ACCESS_TOKEN|KNOWLEDGE_TOKEN)["']?\s*[:=]\s*["'`][A-Za-z0-9_\-.+/]{24,}|^\s*(export\s+)?(ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|RATE_LIMIT_SECRET|EVAL_ACCESS_TOKEN|KNOWLEDGE_TOKEN)=(?!\$)[^\s#]{24,}/m],
];
// Server-only names must never appear in what the browser downloads.
const PUBLIC_FORBIDDEN = /SERVICE_ROLE|service_role|ANTHROPIC_API_KEY|RATE_LIMIT_SECRET|KNOWLEDGE_TOKEN|EVAL_ACCESS_TOKEN/;
let found = 0;
for (const f of walk(root)) {
  if (/\.(png|jpg|jpeg|ico|gif|webp|pdf|zip)$/i.test(f)) continue;
  const rel = f.replace(root, "");
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [kind, re] of RULES) if (re.test(line)) { found++; console.error(`✗ ${rel}:${i + 1} looks like a ${kind}`); }
    if (rel.startsWith("public/") && PUBLIC_FORBIDDEN.test(line)) { found++; console.error(`✗ ${rel}:${i + 1} mentions a server-only secret name in a browser file`); }
  });
}
console.log(`${found ? "✗" : "✓"} secrets: ${found} finding${found === 1 ? "" : "s"}`);
process.exit(found ? 1 : 0);
