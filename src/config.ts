// Every setting comes from the environment. On Render these are set in render.yaml
// or, for secrets, on the service's Environment page. Locally, copy .env.example to .env.
import fs from 'node:fs';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/hub_dev?host=/var/tmp/hubpg',
  databaseSsl: env.DATABASE_SSL === 'true',
  port: Number(env.PORT ?? 3000),
  appUrl: (env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  resendApiKey: env.RESEND_API_KEY ?? '',
  mailFrom: env.MAIL_FROM ?? 'Aalbor Hub <hub@aalborkitchens.com.au>',
  initialEditorEmail: env.INITIAL_EDITOR_EMAIL ?? '',
  initialEditorName: env.INITIAL_EDITOR_NAME ?? 'George Sowmi',
  production: env.NODE_ENV === 'production',
};
