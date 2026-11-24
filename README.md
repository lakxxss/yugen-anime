# Yūgen

Anime discovery site with optional email/password accounts and synced watchlists.

## Run locally

Install Node.js 22 or newer, open a terminal in this folder, then run:

```sh
npm install
npm start
```

Open <http://127.0.0.1:4173>. Without `DATABASE_URL`, local account records are saved in `data/users.json`. Keep that file private and do not commit it.

## Hosted preview

The web service listens on the host's `PORT` and binds to `0.0.0.0` when that variable is set. Set `NODE_ENV=production` and provide `DATABASE_URL` for PostgreSQL. At startup, the app creates the account, watchlist, and session tables. In production, the server refuses to start without PostgreSQL; accounts are never saved to a deploy's temporary local disk.

The included `render.yaml` prepares a free Render web service and prompts for `DATABASE_URL` as a secret. To preserve accounts beyond Render's free database preview, create a PostgreSQL project with a managed provider such as Neon, copy its connection string into the Render dashboard, and keep it out of source control. The app initializes its tables when it starts. The included Dockerfile can also be used by another container host.

Render supports Node web services, deploys from Git, and supplies a public `onrender.com` address. Its free web service spins down after 15 idle minutes and can take about a minute to start again. Its free Postgres expires after 30 days, so the blueprint uses an external database connection instead. See [Render web services](https://render.com/docs/web-services) and [Render free instance limits](https://render.com/docs/free). Neon currently lists a free Postgres allowance of 1 GB storage and 100 compute-hours per project each month; see [Neon plans](https://neon.com/docs/introduction/plans).

## Before inviting public users

This is an initial account implementation. Add email verification, password reset, account deletion, privacy/terms pages, production backups, and durable rate limiting before treating it as a production identity system. The catalog is sample content; streaming requires licensed video sources.

