import pg from 'pg';
import { config } from '../config.js';

// Dates stay as 'YYYY-MM-DD' strings everywhere; never let pg turn them into JS Dates.
pg.types.setTypeParser(1082, (v) => v);
// Timestamps as ISO strings too (UTC); show them with sydneyDate() / Intl in Australia/Sydney.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
// numeric comes back as a string; the hub only uses small values, so a number is safe.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export type Db = pg.PoolClient;

/** Run fn in one transaction with Postgres told who is acting. Every write goes through here or withSystem(). */
export async function withPerson<T>(personId: number, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(fn, "select set_config('hub.person_id', $1, true)", [String(personId)]);
}

/**
 * For the bot's API calls (src/web/api.ts): Postgres knows the token, not a person, so
 * hub_guard() refuses any change to jobs or steps and hub_suggestion_guard() lets it add
 * suggestions only.
 */
export async function withToken<T>(tokenId: number, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(fn, "select set_config('hub.token_id', $1, true)", [String(tokenId)]);
}

/** For migrations, the Notion import, sign-in and the API's own bookkeeping (token last used, call log) only. */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(fn, "select set_config('hub.system', 'on', true)", []);
}

async function inTransaction<T>(fn: (db: Db) => Promise<T>, setup: string, params: string[]): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(setup, params);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres error code raised by hub_guard() when a role may not make a change. */
export function isPermissionError(err: unknown): err is Error {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '42501';
}
