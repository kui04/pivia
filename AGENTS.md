# AGENTS.md

## Environment

- Run project commands inside `devenv shell` or with direnv loaded. The shell provides the pinned Node and pnpm, and
  installs the git hooks.
- The repository is a pnpm workspace. Each package lives in `packages/<name>` and owns its `package.json` and
  `tsconfig.json`. A package `tsconfig.json` extends `tsconfig.base.json`.
- `@earendil-works/pi-coding-agent` requires Node 22.19 or newer (its `engines` field). Keep the Node version in
  `devenv.nix` and the root `engines` field above that floor.
- Keep `typescript` on the range that `typescript-eslint` accepts. Check with `pnpm peers check` before you raise it.

## Checks

- `prek run -a` runs every git hook: deadnix, eslint, nixfmt, prettier and statix. Run it before handing work back.
- `pnpm lint` runs eslint. `pnpm format:check` runs prettier in check mode.
- `pnpm typecheck`, `pnpm test` and `pnpm build` run the script of the same name in every package that defines it.

## Commits

- Write commit messages in the conventional commits format, all lowercase, in english. When the body exceeds one
  line, use an unordered list. Keep the whole project in english.

## Documentation

- Do not cite untracked, deleted, or temporary files (such as scratchpads or deleted implementation plans) in
  comments, docstrings, or commit messages. Write self-contained rationale instead.
- Update documentation, code comments, and references when code changes, and remove obsolete references promptly.
