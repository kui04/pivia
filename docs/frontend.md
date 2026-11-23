# Frontend

Component conventions live in [components.md](components.md). Frontend code lives in `packages/web`.

## Environment

- TypeScript is pinned to `~6.0.3` because `typescript-eslint` 8.x requires `<6.1`. Do not upgrade to TypeScript 7
  without replacing type-aware linting.

## Styles

- `packages/web/src/styles/token.css` holds the design tokens: VS Code Modern colors mapped to Material 3 roles, the M3
  Expressive type and shape scales, spacing, elevation and motion. Use its tokens instead of raw values. If a token is
  missing, ask the user before adding it or using a raw value.
- `--color-outline-control` is the 3:1 boundary for interactive controls (Input, Select, Checkbox and the secondary
  Button), meeting WCAG 1.4.11 in both themes. `--color-outline` stays the decorative editor separator.
- `--color-tertiary` is the single purple accent: skill invocation headers, extension message headers and the border
  of a `!!` command record use it. Keep it out of error and warning roles.
- `packages/web/src/styles/reset.css` is a trimmed Tailwind CSS Preflight. Load order in `packages/web/src/main.tsx` is
  fonts, token, reset, global; `global.css` holds only document-level rules.
- Colors use `light-dark()` with `color-scheme`. Set `data-theme="light"` or `data-theme="dark"` on `<html>` to
  override the system theme.
- `packages/web/src/styles/fonts.css` bundles IBM Plex Sans, Serif and Mono through `@fontsource`; `--font-sans`,
  `--font-serif` and `--font-mono` in `token.css` name them with system fallbacks. `global.css` disables font
  synthesis, so a new weight or style needs a real face in `fonts.css`.

### Nesting

CSS modules use native nesting, no preprocessor. These rules define the usage:

- A rule nests under the selector of an element that contains it in the DOM: `.parent { .child { ... } }` compiles to
  `.parent .child`. The TSX or the story markup must prove the relationship; never nest siblings, and never nest a
  portal part that is not a descendant of its parent. Nesting a descendant adds one class of specificity (`.child`
  goes from `0,1,0` to `0,2,0`), so keep a rule top-level when a caller or another rule must still override it.
- A state on the same element nests with `&`: `&:hover`, `&:focus-visible`, `&[data-open]`, `&::after`. Use
  `&.otherClass` only when the authored selector was already `.root.otherClass`, so the compiled selector and its
  specificity stay the same.
- A class handed to another component's root through `className` (Button, Input, IconButton, ScrollArea, ...) stays a
  top-level rule, even when that component renders inside a local element. Nested, it would outrank that component's
  own hover, focus and disabled rules. A contextual rule that must outrank it, such as `.search .searchInput`
  restating the Input box, is the exception: keep the reason in a comment and restate the states it must win against.
- A class that the component itself accepts from a caller (`className` on Dialog, Menu, ...) keeps the specificity it
  had before nesting. Wrap the ancestors in `:where()` so the nesting adds no class: `.viewport { :where(.popup) { ...
} }` compiles to `.viewport :where(.popup)`. Use this for a public class only; an internal class may gain
  specificity.
- A class applied to the same element as another local class (a size or radius preset) stays top-level too. Nesting it
  as `&.preset` raises its specificity from `0,1,0` to `0,2,0`, and it could then override a caller's `className`.
- Nest `@media`, `@supports` and `@container` inside the block whose rules they all qualify. Otherwise keep the at-rule
  at the top level and nest its rules per element.
- Preserve the cascade. Nesting moves a rule to its parent block, so it must not cross another rule that can match the
  same element and set an overlapping property. Keep declaration order.

Every module opens with a sketch of the nesting. The sketch shows this file's nesting, not the full DOM: when a DOM
parent is not a CSS ancestor here, draw the CSS tree and name the DOM parent in the note. The header of
`ScrollArea.module.css` shows the shape:

```css
/*
 * The scroll container with overlay scrollbars.
 *
 * The markup this file styles (Base UI renders all of it):
 *
 *   .root
 *   ├─ .viewport[tabindex]     the scrolling element
 *   ├─ .scrollbar[data-orientation]
 *   │   └─ .thumb              Base UI moves it from the start edge
 *   └─ .corner
 */
```

Draw the tree with `├─`, `└─` and `│`, one selector or grouped selector per line, and a short note on the same line.
List the classes the TSX adds in their tree position. A module with one class gets a one-line sketch. Keep the sketch
in step with the file: a new nested rule updates the sketch in the same change.

## Viewport and keyboard

- `packages/web/src/main.tsx` listens to `visualViewport` and writes `--vv-height`, `--vv-offset-top`, `--kb-inset` and
  `data-keyboard-open` on `<html>`. Pages use `--kb-inset` for bottom actions and scrolling space. Do not also size
  the page with `--vv-height`: both values follow the visible viewport, so using them together applies the keyboard
  inset twice.
- `data-keyboard-open="true"` lets a page tighten its header while the keyboard is up. The attribute is absent when
  no keyboard is detected.

## Storybook

- Stories sit next to their component as `*.stories.tsx` and are served by Storybook on port 6006; static builds write
  to `storybook-static/`.
- `packages/web/.storybook/main.ts` registers `@storybook/addon-docs`, `@storybook/addon-a11y` and
  `@storybook/addon-vitest`. `packages/web/vitest.config.ts` defines the `unit` (`*.test.ts` in Node) and `storybook`
  (Chromium via Playwright, running `play` functions and failing on axe violations) Vitest projects.
- `packages/web/.storybook/preview.ts` loads the stylesheets in the same order as `packages/web/src/main.tsx` and sets
  `a11y.test` to `"error"`. A story that cannot meet a rule yet can set `parameters: { a11y: { test: "todo" } }`.
- Tests need the `devenv shell`: it sets `PLAYWRIGHT_BROWSERS_PATH` to `pkgs.playwright-driver.browsers`, because
  Playwright cannot download a working browser for NixOS. Keep the `playwright` version in `packages/web/package.json`
  exactly on the `playwright-driver` version of the pinned nixpkgs, or the browser revision it looks up will be missing.

## Routing

- `packages/web/src/router.tsx` holds the route table and creates the single router instance at module load. A data
  router must not live in React state, so `main.tsx` only passes it to `RouterProvider`.
- The router uses `createBrowserRouter`. The Node server serves the PWA and falls back non-API paths to `index.html`,
  providing clean URLs without interfering with `#fragment` anchors. React Router 8 dropped `react-router-dom`: import
  `RouterProvider` from `react-router/dom`, and components, hooks and `Link` from `react-router`.
- Pages live in `packages/web/src/pages/<Name>/` with a CSS Module, beside the components they compose. `AppLayout` is
  the root route and renders `<Outlet />`, so chrome and auth gates shared by every route belong there. `RouteError`
  renders without `AppLayout`.
- `/workspace` is a layout route (`WorkspaceLayout`) that owns the workspace shell (sidebar or drawer, topbar, settings,
  catalog sync) and renders the chat column through its `<Outlet />`, so the shell never remounts while the active
  session changes.
- Because the app connects to a single host, there is no multi-host connect page. Unauthenticated access prompts for
  the server token via an auth gate or modal and proceeds straight into the workspace once authenticated.
- The root route sets `errorElement`. A render error, a rejected route import and an unknown URL all render `RouteError`
  instead of a blank page.

## Hooks

- A reusable hook that owns no component and belongs to no single page feature lives in
  `packages/web/src/hooks/<name>.ts` and is imported as `@/hooks/<name>`, such as `useMediaQuery` and `useNow`.
- A hook that reads the context of one component stays beside it, in `packages/web/src/components/<Name>/`. A hook
  that holds the state of one page stays beside that page, in `packages/web/src/pages/<Name>/`, such as
  `useWorkspaceSync` in `Workspace/`. Moving those to `hooks/` would separate a rule from the only code that can call it.
- Do not add an index barrel to `packages/web/src/hooks/`; import the file directly.

## State and transport

- Zustand stores and their models live in `packages/web/src/stores/<name>/`; each store module exports a pure factory
  (`createAuthStore`, `createSessionStore`, `createWorkspaceStore`) and its persisted/model types without cross-store
  imports or module-load side effects. `packages/web/src/stores/index.ts` is the composition root that creates and
  wires the app-wide singletons (`useAuthStore`, `useSessionStore`, `useWorkspaceStore`).
- HTTP and WebSocket client wrappers stay in `packages/web/src/lib/transport/` (using shared wire types from
  `packages/protocol`), because they are transport, not state.

## Workspace sync

- `useWorkspaceSync` hydrates the stale-while-revalidate catalog from IndexedDB on mount, subscribes to
  `/ws/workspace` for `SyncFrame<"catalog", CatalogSnapshot, CatalogDelta>` updates (`sync:snapshot`, `sync:replay`,
  `sync:delta`, `sync:resync`), reconnects with exponential backoff (and immediately when the document becomes visible
  again), probes `/api/auth/status` after repeated close failures so an expired session drops to the auth gate, and
  provides a single-flight manual refresh via `GET /api/sessions`.
- `CatalogSyncPhase` is `idle`, `syncing`, `live`, `reconnecting`, or `failed`. While `syncing`, the sidebar shows the
  loading skeleton and disables the refresh button with `focusableWhenDisabled` so focus is preserved. While
  `reconnecting` or `failed`, the last known rows stay visible under a status banner.

## Session view

- `WorkspacePage` owns the routed chat column. Its page hook `useWorkspaceSession` parses `:sessionId` with
  `parseSessionId`, calls `connect(parsedId)` in an effect and `disconnect()` on route change and unmount, and
  disconnects instead of connecting for a missing or invalid segment. The page takes an optional `sessionStore` prop
  so stories and tests drive an isolated store.
- The transcript never walks the entry tree. `projectSessionTranscript` from `@pivia/protocol` resolves the active
  branch, the compaction boundary and `context_edit` replacements; `buildTranscript` in
  `packages/web/src/stores/session/transcript.ts` folds those items into user bubbles, skill invocation rows, bash
  execution blocks, labeled extension message blocks, system notes and `Worked for Xs` turn groups. One `/skill:`
  user entry becomes a collapsed `[skill] name` row followed by the prompt bubble when the reader typed one. A `!`
  command record becomes its own block between turns, with its output, exit state and the truncation path. A displayed
  `custom_message` becomes a collapsed row labeled `[customType]` that shares the system-note shell; expanding it shows
  the message as Markdown and its images through the shared viewer, so an extension message never reads as the reader's
  own words. `liveAssistantMessage` joins the same aggregation, so a streamed answer renders before its entry lands.
- Page states in order: missing or invalid session, first snapshot pending, entry-sync failure with a Retry action,
  terminal connection error, empty session, transcript. A failed entry sync with cached rows keeps the transcript
  and adds a status banner instead of replacing it.
- `packages/web/src/pages/Workspace/components/Transcript/` holds the read-only view (user bubbles, skill invocation
  blocks, bash execution blocks, extension message blocks, turn groups, thinking and tool blocks, system notes,
  auto-scroll) and the live-duration hook. The composer slot below it is still a placeholder.
- A transcript item's timing is a discriminated union: a settled turn or tool call carries its final duration, a
  running one carries its start time and the component samples the clock. The two shapes are exclusive so a caller
  cannot add a live elapsed time to a snapshot duration twice. Only the trailing turn of an active runtime may report
  an unmatched tool call as running; a historical call without its result is interrupted.

## Toasts

- `packages/web/src/lib/toast.ts` owns the app's single toast manager plus `showError` and `showWarning`.
  `main.tsx` mounts the one `ToastProvider` at the top center, so every route and outside-React caller reports
  to the same stack. Do not mount a second provider.

## Checks

- Typecheck, ESLint, unit tests and Storybook browser tests cover the frontend checks.
- The ESLint git hook sets `require_serial` in `devenv.nix`. Without it, prek starts one batch per CPU core. Each
  type-aware ESLint process loads the TypeScript projects, and 16 concurrent processes used all the memory of a 16 GB
  host.
- Stop the Storybook dev server before the Storybook browser tests. Each worker loads the whole preview bundle.
