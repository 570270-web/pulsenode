/**
 * Cookie jars in D1.
 *
 * A deployed Worker is not a long-lived process: the module-level Map used by
 * the Node server can disappear between two requests. So on Cloudflare the jar
 * lives in the site's D1 database, keyed by our pl_sid session id.
 *
 * Rows expire. Every row carries `touched`, bumped whenever we save a session,
 * and a small sample of requests sweeps rows older than JAR_TTL_MS. Without
 * that, abandoned sessions would accumulate in the database forever.
 *
 * The rules for *which* cookie belongs to which request stay in src/cookies.js;
 * this file only loads and saves rows.
 */

const JAR_TTL_MS = 12 * 60 * 60 * 1000;
/** Sweeping on every request would be a write per asset; a sample is enough. */
const SWEEP_CHANCE = 0.05;

const SCHEMA = `CREATE TABLE IF NOT EXISTS jar (
  sid TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  host_only INTEGER NOT NULL,
  secure INTEGER NOT NULL,
  expires INTEGER,
  created INTEGER NOT NULL,
  touched INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sid, domain, path, name)
)`;

const SELECT = 'SELECT domain, path, name, value, host_only, secure, expires, created FROM jar WHERE sid = ?';

/** Fallback when no D1 binding is configured (local `wrangler dev` without DB). */
const memory = new Map();

/** One table check per isolate, not per request. */
let ready = false;

/** Create the table, and add `touched` to jars made by the first deployment. */
async function ensureTable(env) {
  if (ready) return;
  await env.DB.prepare(SCHEMA).run();
  try {
    await env.DB.prepare('ALTER TABLE jar ADD COLUMN touched INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    // Already there.
  }
  ready = true;
}

function toCookie(row) {
  return {
    name: row.name,
    value: row.value,
    domain: row.domain,
    hostOnly: row.host_only === 1,
    path: row.path,
    expires: row.expires ?? null,
    secure: row.secure === 1,
    httpOnly: false,
    created: row.created,
  };
}

/** Drop jars nobody has written to for JAR_TTL_MS. */
async function sweep(env) {
  if (Math.random() > SWEEP_CHANCE) return;
  try {
    await env.DB.prepare('DELETE FROM jar WHERE touched < ?').bind(Date.now() - JAR_TTL_MS).run();
  } catch (error) {
    console.error('[proxylab] jar sweep failed:', error?.message);
  }
}

export async function loadJar(env, sid) {
  if (!env?.DB) {
    const entry = memory.get(sid);
    if (!entry) return [];
    if (Date.now() - entry.touched > JAR_TTL_MS) {
      memory.delete(sid);
      return [];
    }
    entry.touched = Date.now();
    return entry.jar.slice();
  }

  try {
    await ensureTable(env);
    const { results } = await env.DB.prepare(SELECT).bind(sid).all();
    await sweep(env);
    return (results || []).map(toCookie);
  } catch (error) {
    // A cookie-store hiccup should degrade to "no cookies", not break the page.
    console.error('[proxylab] jar load failed:', error?.message);
    return [];
  }
}

export async function saveJar(env, sid, jar) {
  if (!env?.DB) {
    memory.set(sid, { jar: jar.slice(), touched: Date.now() });
    return;
  }

  await ensureTable(env);

  const touched = Date.now();
  const statements = [env.DB.prepare('DELETE FROM jar WHERE sid = ?').bind(sid)];
  for (const cookie of jar) {
    statements.push(
      env.DB
        .prepare(
          'INSERT INTO jar (sid, domain, path, name, value, host_only, secure, expires, created, touched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          sid,
          cookie.domain,
          cookie.path,
          cookie.name,
          cookie.value,
          cookie.hostOnly ? 1 : 0,
          cookie.secure ? 1 : 0,
          cookie.expires ?? null,
          cookie.created,
          touched,
        ),
    );
  }
  await env.DB.batch(statements);
  await sweep(env);
}
