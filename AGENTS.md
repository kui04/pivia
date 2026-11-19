# AGENTS.md

## Environment

- Run project commands inside `devenv shell` or with direnv loaded. The shell provides the pinned Node and pnpm,
  Playwright browsers for NixOS (`PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`), and the git hooks.
- The repository is a pnpm workspace. Each package lives in `packages/<name>` and owns its `package.json` and
  `tsconfig.json` extending `tsconfig.base.json`:
    - `packages/protocol`: shared HTTP and WebSocket protocol types.
    - `packages/server`: Node server and CLI wrapping `@earendil-works/pi-coding-agent` in-process for a single host.
    - `packages/web`: React PWA frontend and component workshop.
- `@earendil-works/pi-coding-agent` requires Node 22.19 or newer (its `engines` field). Keep the Node version in
  `devenv.nix` and the root `engines` field above that floor.
- Keep `typescript` on the range that `typescript-eslint` accepts. Check with `pnpm peers check` before you raise it.

## Server Layout

- Organize `packages/server/src` by domain rather than as a flat list of files.
- Keep unit and route tests colocated next to their source file as `*.test.ts`.

## Frontend

- Before changing frontend code, read `docs/frontend.md`. It covers the frontend environment, styles, Storybook,
  routing, state and checks.
- Before changing UI or a component, read `docs/components.md`.

## Logging

- Server code (`packages/server`) logs through the server logger module writing structured records to `stderr`. Do not
  call `console.*` directly for application logs.
- Frontend code (`packages/web`) logs through `Log` (`Log.trace`, `Log.debug`, `Log.info`, `Log.warn`, `Log.error`) in
  `packages/web/src/lib/log.ts`, which writes to the browser console. Do not call `console.*` directly for application
  logs.

## Checks

- `prek run -a` runs every git hook: deadnix, eslint, nixfmt, prettier and statix. Run it before handing work back.
- `pnpm lint` runs eslint. `pnpm format:check` runs prettier in check mode.
- `pnpm typecheck`, `pnpm test` and `pnpm build` run the script of the same name in every package that defines it.
- Frontend checks live in `docs/frontend.md`. Run Storybook browser tests alone: their workers each load the whole
  Storybook preview, so they must not run beside the Storybook dev server or `prek run -a`.

## Commits

- Write commit messages in the conventional commits format, all lowercase, in english. When the body exceeds one
  line, use an unordered list. Keep the whole project in english.

## Documentation

- Do not cite untracked, deleted, or temporary files (such as scratchpads or deleted implementation plans) in
  comments, docstrings, or commit messages. Write self-contained rationale instead.
- Update documentation, code comments, and references when code changes, and remove obsolete references promptly.
