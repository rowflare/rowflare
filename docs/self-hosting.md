---
title: Self-hosting on Cloudflare
description: Deploy Rowflare to your own Cloudflare account with one click or from the command line, or run it with Docker on any server. Requirements, created resources, settings, updates, backups and costs.
order: 10
---

Rowflare runs entirely inside your own Cloudflare account. Each base is one SQLite-backed Durable Object; a Worker serves the app and the REST API; D1 stores accounts and workspaces; R2 stores attachments.

If you would rather run it on your own server, use the [Docker image](#docker) instead. It needs no Cloudflare account.

## Requirement: Workers Paid plan ($5/month)

On Cloudflare, Rowflare needs the Workers Paid plan, which costs $5/month per Cloudflare account and covers the whole team, with unlimited users.

The free plan is not enough for a real team:

- It allows 10 ms of CPU per request. A filter or sort on a 50,000-row base takes 74-80 ms inside the Durable Object.
- It allows 5 million SQLite rows read per day. One filter on a 50,000-row base reads 50,000 rows, so roughly 100 filters a day use up the quota.

The Paid plan includes 25 billion rows read per month.

## One-click deploy

1. Open the deploy link: <https://deploy.workers.cloudflare.com/?url=https://github.com/rowflare/rowflare>
2. Sign in to Cloudflare. Cloudflare copies the repository into your GitHub or GitLab account and builds it.
3. Confirm the proposed resource names (the defaults are fine).
4. Open the URL shown when the deploy finishes, for example `https://rowflare.your-subdomain.workers.dev`.
5. Sign up right away. The first user to sign up becomes the owner of the instance. After that, other people join by invite.

### What the button creates

| Resource | Used for |
| --- | --- |
| Worker | Serves the web app and the REST API, routes each base to its Durable Object |
| Durable Object namespace | One SQLite-backed Durable Object per base: rows, fields, views, formulas |
| D1 database | Users, workspaces, memberships, invites, API tokens |
| R2 bucket | Attachments, including files copied from Airtable |
| Cron trigger | Hourly maintenance jobs |

## Settings (environment variables)

Set these in the Cloudflare dashboard (your Worker, Settings, Variables and Secrets) or in `wrangler.jsonc`. Store keys and passwords as secrets.

| Variable | Values | What it does |
| --- | --- | --- |
| `MODE` | `"selfhost"` (default) or `"cloud"` | Who can sign up. `selfhost`: the first user becomes the owner, everyone else joins by invite. `cloud`: open sign-up for anyone, and a daily system email limit per workspace (below). There are no trials, plans or payments in this repository. |
| `ALLOW_SIGNUP` | `"false"` (default) or `"true"` | Let anyone who can reach the instance create an account. |
| `APP_URL` | `https://your-domain` | Public URL of the instance, used to build absolute links. |
| `SECRET_KEY` | any long random string | Encrypts the AI service keys, Resend API keys and SMTP passwords that workspace owners save. Without it those credentials cannot be stored. Changing it makes saved credentials unreadable, so owners must enter them again. |
| `EMAIL_FROM` | `automations@your-domain` | Sender address for system email, used with the `EMAIL` binding below. |
| `MAIL_PROVIDER` | unset, `"resend"` or `"smtp"` | How account emails (email verification, password reset links) are sent when there is no `EMAIL` binding. See "Account emails" below. |
| `AUTH_EMAIL` | unset or `"code"` | `"code"` replaces passwords with a 6-digit code mailed to the person; needs account email. See "Sign in with an email code" below. |
| `MAIL_FROM` | `noreply@your-domain` | Sender address for account emails sent through `MAIL_PROVIDER`. |
| `RESEND_API_KEY` | secret | Resend API key, with `MAIL_PROVIDER=resend`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD` | `SMTP_SECURITY`: `starttls` (default), `tls` or `none`; the port defaults to 587 (465 with `tls`) | SMTP server for account emails, with `MAIL_PROVIDER=smtp`. Store the password as a secret. |
| `AUTOMATION_MONTHLY_RUNS` | `10000` (default) | Automation runs per base per month. `0` means no limit. Runs over the limit are recorded as skipped. |
| `AUTOMATION_ALLOW_PRIVATE` | `"false"` (default) or `"true"` | Let automation HTTP steps and AI services reach localhost and private network addresses (and accept `http://` AI service addresses), for example a local Ollama. Only for servers on a private network that call internal services. In Docker, the server otherwise resolves every outgoing request and refuses host names that point at private addresses. |
| `AI_WORKERS_MONTHLY_CALLS` | unset (no limit) | Workers AI calls per workspace per month, when the `AI` binding below is set. Calls over the limit mark cells "This month's Workers AI quota is used up". Own-key services have no limit. |

### System email (optional)

Automations can send email through Cloudflare Email Service without any setup by workspace owners. Add a `send_email` binding named `EMAIL` to `wrangler.jsonc` and set `EMAIL_FROM`:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

The sender domain must be onboarded to Cloudflare Email Service, which is in Beta and needs the Workers Paid plan. In cloud mode each workspace can send 100 system emails a day. Without the binding, workspace owners can still set up Resend or SMTP under Settings, Email sending.

### Account emails (optional)

With a way to send email, Rowflare mails a link to confirm the address after sign-up (the app shows "Check your inbox to confirm your email" with "Send again" until it is confirmed; unconfirmed accounts work normally) and offers "Forgot password?" on the login page. Reset links work for one hour and sign out the account's other sessions; confirmation links work for 24 hours. An address gets at most 5 of these emails an hour, and "Forgot password?" answers the same whether or not an account exists.

Rowflare uses the first of these that is set up: the `EMAIL` binding with `EMAIL_FROM` (Cloudflare Email Service, as above), `MAIL_PROVIDER=resend` with `RESEND_API_KEY` and `MAIL_FROM`, or `MAIL_PROVIDER=smtp` with the `SMTP_*` settings and `MAIL_FROM`. Without any of them, the links are not offered and the "Forgot password?" page asks people to contact whoever runs the instance. Accounts that existed before this feature count as confirmed.

### Sign in with an email code instead of passwords (optional)

With `AUTH_EMAIL=code` and one of the account email setups above, people sign in by typing their email and the 6-digit code Rowflare mails to it. There are no passwords: sign-up and log-in are the same page, and the account (with its first workspace) is created when the first code is entered. Codes work once, for 10 minutes, with at most 5 wrong tries; an address gets at most 5 codes an hour, one network address at most 10, and the instance at most 1,000; the page answers the same whether or not an account exists or a limit was reached. Password sign-up, log-in, "Forgot password?" and the password section of Settings are turned off. Without account email the setting has no effect and the instance keeps passwords. Accounts that already have a password sign in with a code from then on.

These settings are only for account emails; automations' email steps use the mail settings each workspace owner saves under Settings, Email sending.

### AI services (optional)

Workspace owners add AI services under Settings, AI services: Anthropic, or any OpenAI-compatible service with its address and model (OpenAI, DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, Gemini, Ollama). This needs `SECRET_KEY`. Calls are billed to the owner's own key.

To also offer Workers AI without a key, add the binding to `wrangler.jsonc`; calls are billed to the Cloudflare account that runs Rowflare, so consider `AI_WORKERS_MONTHLY_CALLS`:

```jsonc
"ai": { "binding": "AI" }
```

The binding is left out of the default configuration because `wrangler dev` and the tests would then need a Cloudflare login.

## Manual deploy

```sh
git clone https://github.com/rowflare/rowflare.git
cd rowflare
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` builds the web app and deploys the Worker with its Durable Object, D1, R2 and cron bindings. Wrangler creates the D1 database and R2 bucket on the first deploy, and the Worker creates its D1 tables on the first request, so there is no separate migration step.

## Docker

The Docker image runs the same Worker code as the Cloudflare deploy, in workerd (Cloudflare's open-source Workers runtime) through Miniflare. Durable Objects, D1 and R2 are stored as SQLite databases and files under `/data`, so mount a volume there.

```sh
docker run -d --name rowflare \
  -p 8787:8787 \
  -v rowflare-data:/data \
  -e APP_URL=https://rowflare.example.com \
  ghcr.io/rowflare/rowflare:latest
```

The same image is on Docker Hub as `rowflare/rowflare`.

Or with Docker Compose, using the `docker-compose.yml` in the repository:

```sh
docker compose up -d
```

Open `http://your-server:8787` and sign up right away: the first user becomes the owner. Put a reverse proxy with HTTPS in front of it (Caddy, nginx, Traefik) for anything beyond a local network, and forward WebSocket upgrades on `/api/bases/*/ws` for real-time collaboration.

Images are published for `linux/amd64` and `linux/arm64`. Tags: `latest` (main branch), `1.2.3` and `1.2` for releases, and `sha-<commit>`.

The settings below are passed as environment variables (`-e MODE=selfhost`). The container also reads:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port the server listens on inside the container. |
| `DATA_DIR` | `/data` | Where Durable Objects, D1 and R2 data are stored. |
| `LOG_LEVEL` | `info` | Set to `debug` for verbose runtime logs. |

To build the image yourself: `docker build -t rowflare .`, or `docker compose up -d --build`.

Automations and AI fields run in the container the same way as on Cloudflare. System email (Cloudflare Email Service) and Workers AI are not available there; Resend, SMTP and own-key AI services work (for account emails, pass `MAIL_PROVIDER` and its settings), so pass `-e SECRET_KEY=...` to let workspace owners save their credentials. To use an Ollama on the same machine or network, also pass `-e AUTOMATION_ALLOW_PRIVATE=true`.

The hourly maintenance job runs inside the container. Differences from Cloudflare: everything runs on one machine, so capacity is limited by that machine's CPU and disk, and there are no D1 Time Travel restores (see backups below).

## Updating

Pull the latest code and deploy again:

```sh
git pull
npm install
npm run deploy
```

If you deployed with the button, sync your fork with the upstream repository and Workers Builds deploys the new commit.

With Docker, pull the new image and recreate the container; the data volume is kept:

```sh
docker compose pull
docker compose up -d
```

## Backups

- D1 Time Travel restores the accounts database to any point in the last 30 days on the Paid plan (`npx wrangler d1 time-travel`).
- Export each base as CSV (per table) or JSON (whole base) and keep the files outside Cloudflare.
- Attachments live in your R2 bucket; copy it with any S3-compatible tool for an off-site copy.
- With Docker, everything is in the `/data` volume. Stop the container and copy the volume, or snapshot the disk it lives on.

## Costs on Cloudflare

Included in the $5/month Workers Paid plan (prices checked 2026-10-12):

| Usage | Included per month | Above the included amount |
| --- | --- | --- |
| Durable Object requests | 1 million | $0.15 per million |
| Durable Object duration | 400,000 GB-s | $12.50 per million GB-s (WebSocket Hibernation idle time is not billed) |
| SQLite rows read | 25 billion | $0.001 per million |
| SQLite rows written | 50 million | $1.00 per million |
| SQLite storage | 5 GB-month | $0.20 per GB-month |

Sources: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Worked example (estimate): 2,000 filters or sorts a day on a 50,000-row base read about 3 billion rows a month, inside the 25 billion included. 100 full formula recomputes a month write about 5 million rows, inside the 50 million included. That team pays $5/month. The included amounts are shared across your whole Cloudflare account; your bill is the source of truth.

## Performance

Median milliseconds inside the Durable Object, test data with 15 fields and about 678 bytes per row, measured 2026-10-12:

| Action | 50,000 rows | 125,000 rows |
| --- | --- | --- |
| Open view, first page | 0.14 | 0.36 |
| Edit a cell + rollup update | 1.4 | 9-12 |
| Rename a record + lookup update | 2.3 | 5.2 |
| Filter by any field | 74 | 405 |
| Sort by any field | 80 | 406 |
| Filter + sort | 155 | 811 |
| Kanban group counts | 125 | 730 |
| Full rollup recompute | 210 | 1,353 |
| Full formula column recompute | 575 | 2,709 |
