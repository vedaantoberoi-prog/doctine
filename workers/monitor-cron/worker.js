/**
 * Doctine · monitor scheduler (Cloudflare Worker "doctine-monitor-cron", cron trigger every 15 minutes).
 * Every 15 minutes it asks the app to run its health round: GET https://app.doctine.com/api/monitor.
 * It sends nothing and holds no secrets: /api/monitor ignores what callers send, checks the services itself, records the
 * results (at most one round per 4 minutes) and evaluates the alert rules. The GitHub "Uptime" workflow stays as a
 * backup; GitHub runs it far less often than scheduled.
 * Its workers.dev address is switched off; the fetch handler only answers 404.
 */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await fetch("https://app.doctine.com/api/monitor", { headers: { "user-agent": "doctine-monitor-cron" } });
      const body = await r.text();
      if (!r.ok) console.log("monitor round failed", r.status, body.slice(0, 200));
    })());
  },
  async fetch() { return new Response("Not found", { status: 404 }); },
};
