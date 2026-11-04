/**
 * Doctine · imported first by tests/functions.test.mjs. It removes every setting the server reads from the environment
 * (AI keys, Supabase, rate limits, knowledge retrieval, DOCTINE_ENV, the evaluation token), so the tests run the same on a
 * laptop, in CI and inside a Netlify build, where the site's own variables are present. Each test sets what it needs.
 * Nothing is printed, and no value is read: names only.
 */
const SERVER_SETTING = /^(ANTHROPIC_|AI_|SUPABASE_|RATE_LIMIT_|KNOWLEDGE_|EVAL_ACCESS_TOKEN$|DOCTINE_ENV$)/;
export const cleared = Object.keys(process.env).filter((k) => SERVER_SETTING.test(k));
for (const k of cleared) delete process.env[k];
