# DNS Manager (Node + Vite + shadcn/ui)

This proof-of-concept application provides a modern Node.js + React frontend for
managing both the classical `soa`/`rr` tables and the mirrored
`cloudflare_*` tables that MyDNS keeps in sync. It mirrors the workflows of
`application/controllers/Admindns.php` and the legacy `contrib/admin.php`
interface, but runs independently of CodeIgniter.

Maintained by Dan Caescu <dan.caescu@multitel.net>.

## Project layout

```
contrib/dnsmanager/
├── README.md
├── server/            # Express + TypeScript REST API
├── client/            # Vite + React + shadcn/ui frontend
└── schema/            # SQL helper for dnsmanager_users
```

The backend automatically reads database credentials (including optional
failover hosts) from `/etc/mydns/mydns.conf` so it shares configuration with
the daemon. Authentication data (username/password hash/role) is stored in the
new `dnsmanager_users` table (see `schema/dnsmanager_users.sql`).

## Prerequisites

* Node.js 20+
* npm 10+
* Access to the MyDNS/MySQL database (the API uses the same credentials as
  `/etc/mydns/mydns.conf`)
* `dnsmanager_users` table populated with at least one admin user. Passwords
  must be bcrypt hashes (use `npm run seed-user --prefix server` to create one).

## Setup

```bash
cd contrib/dnsmanager
npm install --prefix server
npm install --prefix client
```

Create a `.env` file inside `server/` if you want to customize the JWT secret:

```
DNSMANAGER_JWT_SECRET=change-me
```

## Development

Run API and client together:

```bash
# from contrib/dnsmanager
npm run dev
```

This proxies the Vite dev server (default 5173) to the API running on 4000.
You can also run the pieces separately:

```bash
npm run dev --prefix server   # Express API
npm run dev --prefix client   # Vite client
```

## Production build

```bash
npm run build --prefix client
npm run start --prefix server
```

The API serves `/api/*` endpoints for:

* `POST /api/auth/login`
* `GET/POST/PUT/DELETE /api/soa`
* `GET/POST/PUT/DELETE /api/rr`
* `GET /api/cloudflare/accounts`
* `GET /api/cloudflare/zones`
* `GET /api/cloudflare/records`
* `GET /api/cloudflare/load-balancers`

The React UI consumes these endpoints and presents modern tables/forms built
with shadcn/ui (Button, Card, Input, Tabs, DataTable) to inspect and modify
DNS data.

## Notes

* The backend inspects `/etc/mydns/mydns.conf` at startup to learn DB hosts.
  Hosts listed under `db-host`, `db-host2`... will be tried in the configured
  `db-host-policy` order (sequential, round-robin, least-used).
* All write actions require a valid JWT issued by `POST /api/auth/login`.
* The client keeps the token in `localStorage` and adds it to the `Authorization`
  header for subsequent API calls.
* This directory is self-contained and does not affect existing PHP tooling.
