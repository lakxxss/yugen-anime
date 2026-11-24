# Yūgen — Anime & Manga Finder

Yūgen helps people discover anime and manga. Browse popular titles, search by title, filter by genre, open a details card, and save titles to a personal list. Accounts are optional; guest lists stay in the browser, and signed-in lists sync to PostgreSQL.

The catalog is powered by public metadata from [Kitsu](https://kitsu.io). It shows anime episode counts and manga chapter/volume counts, and links to Kitsu or available external title services. Yūgen is a discovery catalog; it does not host full episodes or manga chapters.

## Features

- Separate anime and manga catalogs with title search, genre filters, and pagination.
- Title details, synopsis, cover art, score, year, and episode or chapter/volume counts when available.
- Episode guide for anime when Kitsu has episode data.
- Personal saved list with optional account sync.
- Responsive layout and official trailer previews for selected anime.

Catalog coverage and metadata depend on Kitsu. The API returns up to 20 catalog records per page; use the “Load more” control to continue browsing.

## Run locally

Use Node.js 22 or newer. From this directory run:

```sh
npm install
npm start
```

Open <http://127.0.0.1:4173>.

Without `DATABASE_URL`, local account records are written to `data/users.json`; keep that file private and out of source control. Production mode requires PostgreSQL. At startup the app creates the account, list, and session tables. Session cookies use secure settings in production.

## API

Yūgen’s HTTP API is documented in [docs/API.md](docs/API.md). It covers the anime/manga catalog, anime episode guide, health check, optional accounts, and saved lists.

## Deployment

The included `Dockerfile` and `render.yaml` support Render deployment. The web service listens on the configured `PORT`; production account sync needs a PostgreSQL connection string supplied as `DATABASE_URL`. Keep secrets in the host’s environment settings, never in Git.

## Before a wider public launch

Add email verification, password recovery and deletion, privacy/terms pages, production database backups, and durable rate limiting before relying on accounts as a public identity system.

