/**
 * Doctine · local development server: serves public/ and runs the real Netlify functions at their /api routes.
 *   node tools/dev-server.mjs            → http://localhost:8888
 * Environment comes from the shell, or from a `.env.local` file in the project root (never committed; see .gitignore).
 * With a real ANTHROPIC_API_KEY this talks to Anthropic; the browser tests point ANTHROPIC_BASE_URL at a stand-in.
 * For development and tests only — production runs on Netlify.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (process.env.DOCTINE_ENV === "production") { console.error("Refusing to run the development server with DOCTINE_ENV=production."); process.exit(1); }

const routes = new Map();
for (const f of readdirSync(join(root, "netlify/functions")).filter((f) => f.endsWith(".mjs"))) {
  const m = await import(join(root, "netlify/functions", f));
  routes.set(m.config.path, m.default);
}
/* The same response headers Netlify adds (from netlify.toml), so local and test runs match the deployed site. */
const HEADERS = [];
for (const block of readFileSync(join(root, "netlify.toml"), "utf8").split("[[headers]]").slice(1)) {
  const pat = (block.match(/for\s*=\s*"([^"]+)"/) || [])[1]; if (!pat) continue;
  const vals = {}; for (const m of block.split("[headers.values]")[1]?.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"/gm) || []) vals[m[1].toLowerCase()] = m[2];
  HEADERS.push([new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), vals]);
}
const headersFor = (path) => Object.assign({}, ...HEADERS.filter(([re]) => re.test(path)).map(([, v]) => v));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".css": "text/css" };

export function startDevServer(port = Number(process.env.PORT) || 8888) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const fn = routes.get(url.pathname);
      if (fn) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
        const out = await fn(request, { ip: req.socket.remoteAddress || "127.0.0.1" });
        res.writeHead(out.status, { ...headersFor(url.pathname), ...Object.fromEntries(out.headers) });
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      if (url.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); return; }
      let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (p.endsWith("/")) p += "index.html";
      const file = join(root, "public", p);
      if (!file.startsWith(join(root, "public")) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { ...headersFor(url.pathname), "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
    } catch (e) {
      console.error("[dev-server]", e);
      res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"server_error"}');
    }
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startDevServer();
  console.log(`Doctine dev server: http://localhost:${s.address().port}  (functions: ${[...routes.keys()].join(", ")})`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("Note: ANTHROPIC_API_KEY is not set, so the assistant will report that it isn't configured.");
}
