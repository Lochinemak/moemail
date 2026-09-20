# Repository Guidelines

## Project Structure & Module Organization

The Next.js 15 application lives in `app/`. Route handlers are under `app/api/`, localized pages under `app/[locale]/`, reusable UI in `app/components/`, and shared server utilities in `app/lib/`. Translation JSON is grouped by locale in `app/i18n/messages/`. Static assets belong in `public/`.

Cloudflare email and cleanup workers are in `workers/`; operational scripts are in `scripts/`. Drizzle SQL migrations and metadata live in `drizzle/`. Keep package-specific code within `packages/core`, `packages/cli`, or `packages/mcp`; each package has its own manifest and TypeScript configuration. Design notes belong in `specs/`.

## Build, Test, and Development Commands

- `pnpm install`: install root dependencies (pnpm 9 is used in CI).
- `pnpm dev`: run the Next.js development server.
- `pnpm lint`: run the Next.js ESLint configuration.
- `pnpm build`: create a production Next.js build and perform type checks.
- `pnpm db:migrate-local`: apply Drizzle migrations to the local D1 database.
- `pnpm dev:cleanup` followed by `pnpm test:cleanup`: run and manually trigger the scheduled cleanup worker.
- `cd packages/cli && pnpm build`: bundle the CLI with Bun. Use the same command in `packages/mcp` for the MCP server.

Copy `.env.example` and the relevant `wrangler.*.example.json` files for local configuration; never commit populated secrets.

## Coding Style & Naming Conventions

Use TypeScript with strict checking. Follow existing formatting: two-space indentation, double quotes, and the surrounding file's semicolon style. Use `PascalCase` for React components and types, `camelCase` for functions and variables, and kebab-case filenames such as `message-list.tsx`. Prefer the `@/` alias for imports from `app/`. Keep route methods named after HTTP verbs (`GET`, `POST`, `DELETE`). ESLint extends `next/core-web-vitals` and `next/typescript`; run `pnpm lint` before submitting.

## Testing Guidelines

Do not write unit tests. This repository currently relies on linting, production builds, and focused manual checks. For UI changes, verify relevant desktop and mobile flows. For Cloudflare worker changes, use the Wrangler commands above and document the scenario tested in the pull request.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style subjects: `feat(roles): ...`, `fix(auth): ...`, `refactor: ...`, and `ci: ...`. Keep commits focused and subjects imperative. Pull requests should explain the change and motivation, identify configuration or migration impact, link related issues, and list verification commands. Include screenshots for visible UI changes and update all affected locale files when user-facing text changes.
