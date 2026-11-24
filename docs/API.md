# Yūgen API

All routes are served by the Yūgen web service. Catalog metadata is proxied from Kitsu’s public JSON:API and cached in memory for five minutes. Catalog endpoints return Kitsu JSON:API resources, including `data`, pagination `links`, and any requested `included` relationships.

## Catalog

### `GET /api/catalog`

Browse anime by default, or manga by setting `type=manga`.

| Query | Description |
| --- | --- |
| `type` | `anime` (default) or `manga`. |
| `q` | Search title text. Limited to 120 characters. |
| `genre` | Genre/category filter. Supported values: `action`, `fantasy`, `romance`, `sci-fi`, `slice of life`, `comedy`, and `drama`. |
| `offset` | Zero-based result offset, capped at 10,000. |
| `ids` | Comma-separated numeric Kitsu IDs, up to 50. Use the matching `type`. |
| `status` | `current` filters currently airing anime. |

Kitsu currently caps a normal page at 20 records. Use the response’s `links.next` to continue. Search and unfiltered browse are sorted by Kitsu popularity. Genre values outside the supported list are ignored.

Examples:

```http
GET /api/catalog?type=anime&q=Frieren
GET /api/catalog?type=manga&genre=action&offset=20
GET /api/catalog?type=manga&ids=1,2
```

Anime requests include Kitsu category and streaming-link metadata. Manga requests include category metadata. The browser UI only presents external discovery links; Yūgen does not serve episode video or manga pages.

### `GET /api/catalog/:id/episodes`

Returns episode metadata for a numeric anime ID. Manga chapter/volume counts are available on each manga record; this route does not provide manga pages or a chapter-reading stream.

| Query | Description |
| --- | --- |
| `offset` | Zero-based episode offset, capped at 2,000. |

Each response contains Kitsu `data`, `links`, and `meta`, plus a boolean `hasMore` derived from `links.next`. Episodes are sorted by number and returned 20 at a time.

```http
GET /api/catalog/1/episodes?offset=0
```

## Health

### `GET /api/health`

Returns `{ "ok": true, "database": "postgres" }` when PostgreSQL is connected. In production, the endpoint returns an unavailable status when the database is not configured. Local development can report `database: "local"`.

## Optional account and saved-list routes

Guest browsing and a browser-local saved list do not require an account. Account routes use an HTTP-only, same-site session cookie.

| Method and route | Purpose |
| --- | --- |
| `GET /api/me` | Return the signed-in user and synced list, or `user: null` for guests. |
| `POST /api/signup` | Create an account from `{ "name", "email", "password" }`. Passwords must be 10–128 characters. |
| `POST /api/login` | Sign in with `{ "email", "password" }`. |
| `POST /api/logout` | End the current session. |
| `GET /api/list` | Read the signed-in user’s saved IDs. |
| `PUT /api/list` | Replace the signed-in user’s saved IDs with `{ "ids": ["..."] }`. |

List routes require a valid session. Account mutations require a same-origin request and are rate-limited. The server stores account records in PostgreSQL when `DATABASE_URL` is configured; local development without PostgreSQL uses `data/users.json`.

## Errors and limits

Errors use a JSON body with an `error` message. Catalog upstream failures return `502`; unauthenticated list requests return `401`; same-origin checks can return `403`; invalid account input returns `400`; repeated account attempts can return `429`. Catalog and episode responses are cached for five minutes.

