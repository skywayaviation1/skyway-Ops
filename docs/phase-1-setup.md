# Phase 1 setup — Postgres control plane

This is the foundation under the multi-tenant plan. The live app at www.skyway.app still reads and writes Firestore. Nothing in this phase changes what crews see. The new Edge route `/api/tenant-context` is not called by the UI.

You chose Supabase for Postgres. There is no Supabase project yet. The SQL in `supabase/migrations` is ordinary Postgres, so it also applies with `psql` if you want to try it locally before creating the project.

## 1. Create the Supabase project

1. In the Supabase dashboard, create a project. Pick a region close to the Vercel project `skyway-ops`. The free tier is enough for this phase.
2. Wait until the database is ready. You do not need Auth, Storage, or Realtime for this phase.
3. Open the SQL editor only if you prefer to paste the migration files yourself. The steps below use the Supabase CLI or a connection string instead.

Do not point the Vite app at this database. Do not turn on a cron.

## 2. Apply the migrations

The files in `supabase/migrations` create the tables, force row-level security, add the app role and the migration role, and seed Skyway.

Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), then from this repo:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

`YOUR_PROJECT_REF` is the id in the Supabase project URL. `db push` applies only the SQL in `supabase/migrations`.

To apply the same files with Node instead of the CLI, set `DATABASE_MIGRATION_URL` in your shell to the **postgres** connection string from Supabase (Project Settings → Database → connection string; use the direct URI, session mode). Then:

```bash
npm run control-plane:migrate
```

That script refuses to run if the connection is the app role. Run it once. A second run prints that the migrations are already applied.

Local Postgres without Supabase works the same way. Create an empty database, set `DATABASE_MIGRATION_URL` to it, and run the same command. `supabase start` also works if you have Docker: it reads `supabase/config.toml` and applies `supabase/migrations`.

## 3. Set the two role passwords

The migration creates three roles and does not put passwords in git.

| Role | Who uses it |
| --- | --- |
| `skyway_app` | The app, later. Cannot bypass row-level security. |
| `skyway_migration` | Migrations and the one-way user copy. Bypasses row-level security. |
| `skyway_owner` | Owns the tables. Still subject to row-level security. Not a login you need. |

In the Supabase SQL editor, run the following with passwords you invent there. Do not commit them and do not paste them into chat.

```sql
ALTER ROLE skyway_app WITH LOGIN PASSWORD 'choose-one';
ALTER ROLE skyway_migration WITH LOGIN PASSWORD 'choose-another';
```

Supabase may require the login name `skyway_app.PROJECT_REF` on the pooler. If a direct connection as `skyway_app` is refused, use the pooler username the dashboard shows when you create a database user with that role, or connect as `postgres` for the manual copy below and keep `skyway_app` for the app URL.

## 4. Environment variables in Vercel

In the Vercel project `skyway-ops`, add this name only. Paste the value in Vercel, not in git.

| Name | Value is |
| --- | --- |
| `DATABASE_URL` | Connection string for **`skyway_app`**, not the migration role and not the Supabase service role. |

No live route reads `DATABASE_URL` yet. Adding it does not change the running app. Leave it unset until the project exists; the app keeps using Firestore.

Do **not** add `DATABASE_MIGRATION_URL` to Vercel. Nothing under `api/` is allowed to use the migration role. You set that name in a shell for the two commands above and below, then unset it.

`FIREBASE_SERVICE_ACCOUNT_JSON` is already in Vercel for the live app. The shadow copy needs it in the shell too. Do not print it.

Optional, only if a hosted connection fails certificate verification: `DATABASE_SSL_REJECT_UNAUTHORIZED`. Leave it unset unless you are debugging SSL. Hosted Supabase connections use SSL without a certificate file in this repo.

## 5. Shadow-copy users (manual, one way)

This reads Firestore `users` in the named database `appusers` and upserts Postgres `users` and `memberships` for tenant `skyway`. It does not write to Firestore. It does not email anyone. It does not change passwords. Running it again updates the same rows.

Unapproved people become membership status `invited`. People with `active: false` become `disabled`. Approved, active people become `active`. The roles `pilot`, `chief-pilot`, and `chief_pilot` are stored as `crew` or `ops` because those strings are not in the tenant role list. The job writes a `job_runs` row named `shadow-copy-users`. `ok` is true only when every Firestore user is present and Postgres does not have extra Skyway memberships. It will not delete a Postgres row that disappeared from Firestore; that run is recorded as not matched so a short read cannot wipe the directory.

From your machine, with the two variables set in the shell only:

```bash
export DATABASE_MIGRATION_URL='postgresql://...'
export FIREBASE_SERVICE_ACCOUNT_JSON='...'
npm run control-plane:shadow-copy
```

If either variable is missing, the script exits before it talks to Firestore. There is no Vercel cron for this. Do not add one until you want it on a schedule.

## 6. What you should see

- Tenant slug `skyway`, billing exempt, plan `internal`, entitlements version 1.
- Domains `www.skyway.app`, `skyway.app`, and `135ops.app`, kind `pinned`.
- Branding copied from `src/brand.js` (legal name Skyway Aviation Services, phone 727-605-5000, charter email, cyan accents).
- Plan `none` contains only `core.home`, `core.users`, and `core.settings`.
- No feature overrides. Every catalog key is on for Skyway.
- `GET /api/tenant-context` on those three hosts returns Skyway. Any other host returns 404. The screens still take their brand from `src/brand.js`.

## 7. Checks

```bash
npm test
npm run test:control-plane
npm run build
```

`test:control-plane` needs a local Postgres. Set `CONTROL_PLANE_ADMIN_URL` to an admin connection string if the default socket login does not work. The tests create a database named `skyway_control_plane_test`. They do not use Supabase and they do not need Firebase.

## 8. Do not

- Do not deploy Firestore rules. The live rules are not in git yet. See `docs/firestore-rules-snapshot.md`.
- Do not call `/api/tenant-context` from the UI.
- Do not switch any screen from Firestore to Postgres.
- Do not put the migration connection string in `DATABASE_URL`.
