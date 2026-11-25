# Contributing to Smart Campus Central Server

Thank you for helping. This repository is the central server of Smart Campus (EPITECH Marseille): the REST API and
admin console, the WSS gateway that door units and Faculty screens dial into, and the orchestration of commands, room
status, announcements, emergencies and audio. [`AGENTS.md`](AGENTS.md) is the full guideline; this page is the short version.

## Before you start

- Open or pick an issue first for anything larger than a typo, so the design is agreed before the code.
- Read the reference design in `docs/` before touching the gateway, the protocol or the crypto. Device identity rests
  on the signed-session handshake plus key pinning, never on TLS alone.
- The door unit and the Faculty screen live in their own repositories and follow the protocol in `packages/protocol`.
  A protocol change is a change for all three: say so in the PR.

## Set up

Needs Node.js, pnpm and Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up   # console :5173, API + gateway :3000, MongoDB, mail catcher :8025
```

## Layout

```
apps/server/         Express 5 + TypeScript + Mongoose: REST API, auth, gateway, scheduler
apps/web/            React 19 + Vite + Tailwind v4 + shadcn/ui admin console
apps/device-sim/     Python device simulator, a protocol test tool
packages/protocol/   envelope, zod schemas, handshake messages (shared with the devices)
packages/handshake/  ECDSA P-256 + ECDH + HKDF + AES-256-GCM channel
```

## Check your work

Before opening a PR, run these at the repository root and fix what they report:

```bash
pnpm typecheck   # builds the packages, then typechecks everything
pnpm test
pnpm build
```

- Pure logic (parsers, crypto, protocol schemas, state machines) gets a unit test. Crypto and handshake code must
  test tampering and replay cases.
- For an API change, exercise the endpoint against a real MongoDB and check the success path **and** the permission and
  validation failures.
- For a UI change, run it in a browser, or say plainly that you could not.

## Conventions

**Server (`apps/server`)**
- ESM with `module: NodeNext`: relative imports end in `.js`.
- Read configuration only through `src/config.ts`. A new variable also goes in `.env.example` and `docker-compose.yml`.
- Validate every request body, query and param with zod. Throw `HttpError(status, message)` for errors.
- Keep routes thin, one router per resource. Reusable logic goes in `auth/`, `lib/`, `domain/`.
- Authorization is enforced on the server (`requireAuth`, `requireRole`); the UI only mirrors it. A new endpoint is closed
  to API keys until it is added to `auth/apiKeyScopes.ts`.
- Send DTOs, never raw documents. Compare secrets with `timingSafeEqual`, hash tokens before storing them.
- Sensitive actions (enrol or revoke a device, role change, emergency broadcast) write an `auditLogs` entry. Treat all
  device input as hostile: size-limited, schema-validated, idempotent.

**Console (`apps/web`)**
- Strict TypeScript, `@/` alias for `src/`, data through `lib/api.ts` and `lib/useFetch.ts`.
- Follow the existing art direction: light cool-gray surfaces, green only as an accent, CSS variable tokens instead of hard-coded colours.
- Accessibility: every input has a label, errors use `role="alert"`, icon-only buttons have an `aria-label`.

Keep `README.md`, `.env.example` and `AGENTS.md` in sync with behaviour changes. Code, comments, commits and docs are in English.

Allowed commit scopes: `server`, `web`, `protocol`, `handshake`, `gateway`, `devices`, `commands`, `announcements`, `assets`,
`access`, `jobs`, `auth`, `campus`, `door`, `edge`, `infra`, `docs`, `deps`.

## Commits and pull requests

- Branch from `main`: `<type>/<short-kebab-description>`, for example `feat/live-announcement`. Never push to `main` directly.
- [Conventional Commits](https://www.conventionalcommits.org/) for every commit and PR title: `<type>(<scope>): <subject>`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Subject in the imperative, lowercase start, no trailing period, 72 characters at most.
- One logical change per commit. Do not mix a refactor with a behaviour change.
- Explain *why* in the body when it is not obvious. Link issues with `Closes #12` or `Refs #7`.
- A PR says what changed and why, how you verified it, and what you could not verify (sound, real hardware, a browser). Keep it small enough to review.
- `main` is protected: a PR needs one approving review.

## Security

Never commit secrets: `.env` files, private keys, certificates, tokens. Only `.env.example` is tracked. Never log or return passwords, hashes, session tokens or key material. To report a vulnerability, do not open a public issue: use the repository's **Security** tab (private vulnerability reporting) or contact a maintainer privately.

## Licence of your contribution

This project is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). By opening a pull request you agree that your contribution is licensed under the same terms.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

