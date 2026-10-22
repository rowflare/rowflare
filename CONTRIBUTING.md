# Contributing to Rowflare

Thanks for helping. Bug reports, reproductions, docs fixes and pull requests are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Keep the scope of the project in mind: Rowflare is an Airtable-style database for bases up to 125,000 rows. Interfaces, app builders and AI features are out of scope.
- Read [docs/architecture.md](docs/architecture.md). The storage rules there come from load tests; changes that break them (for example expression indexes on the row JSON, or one shared physical table for all user tables) will not be merged.

## Development setup

```sh
npm install
cp .dev.vars.example .dev.vars
npm run build:web
npx wrangler dev
```

Open http://127.0.0.1:8787 and sign up (the first local account becomes the owner).

## Checks

Run all of these before opening a pull request:

```sh
npm run typecheck
npm test
npm run build
```

Changes to the storage engine (`src/worker/base/`) should include an integration test in `test/worker/` and, when they touch reads or writes in bulk, before and after timings in the pull request.

## Style

- TypeScript everywhere, 2-space indent, double quotes. Match the code around your change.
- Comments explain why, not what. Keep them short.
- Code, comments and UI text are in English.

## Contributor License Agreement

Rowflare is AGPL-3.0 and also offered under a commercial license, which pays for development. To make that possible, every contributor signs the [CLA](CLA.md) once. The CLA bot comments on your first pull request with instructions; reply with the sentence it asks for. You keep the copyright in your work, and the CLA commits the maintainers to keeping every accepted contribution available as open source.

## Security

Please do not open public issues for security problems. Report them privately through GitHub's "Report a vulnerability" button on the repository's Security tab.
