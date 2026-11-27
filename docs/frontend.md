# Frontend

Component conventions live in [components.md](components.md). Frontend code lives in `packages/web`.

## Environment

- Pin `typescript` to `~6.0.3` because `typescript-eslint` 8.x requires `<6.1`. Do not upgrade to TypeScript 7 without replacing type-aware linting.
- Pin `playwright` in `packages/web/package.json` to the exact `playwright-driver` version from nixpkgs so Chromium revisions match inside `devenv shell`.

## Module Entry Points

- Every component folder owns an `index.ts` barrel: the design system under `components/<Name>/`, the workspace components under `pages/Workspace/components/<Name>/`, the composer components under `pages/Workspace/components/Composer/components/<Name>/`, and the transcript components under `pages/Workspace/components/Transcript/components/<Name>/`. Import the folder, not its implementation file: `@components/Icon`, `../IconButton`, `@components/Toast`. The folder barrel is the only place that joins the folder name to its implementation file.
- The public app-wide barrels are `@components`, `@/hooks`, `@/lib`, and `@/stores`. `@components` re-exports the design system; `@components/<Name>` reaches one component folder. `@/stores` is the composition root only; import domain factories and types from `@/stores/auth`, `@/stores/session`, or `@/stores/workspace`.
- Feature modules follow the same rule. Import the transcript view and its queue helpers from `pages/Workspace/components/Transcript`, workspace shell components from `pages/Workspace/components`, and route pages from their folder barrels such as `@/pages/Workspace`. Do not add a `pages/index.ts` aggregate; each route stays explicit in `router.tsx`.
- Subsystem entry points are `@/lib/cache`, `@/lib/sync`, and `@/lib/transport`. Import their public types and functions from the barrel instead of a file inside the subsystem.
- Keep a deep import only when a barrel would load browser-only assets into a Node unit test. `lib/toast.ts` imports `Toast/useToast`, and `stores/session/tool-details.ts` imports `CodeBlock/highlight`, for this reason. Move the shared helper to `lib` before widening either barrel.

## Styles

- `packages/web/src/styles/token.css` holds the design tokens (VS Code Modern colors mapped to Material 3 roles, M3 Expressive type/shape scales, spacing, elevation, and motion). Use tokens instead of raw values; ask before adding tokens or using raw values.
- `--color-outline-control` provides the 3:1 boundary for interactive controls (`Input`, `Select`, `Checkbox`, secondary `Button`); `--color-outline` stays the decorative separator.
- `--color-tertiary` is the single purple accent for skill invocation headers, extension message headers, and non-failed `!!` command borders. Keep it out of error and warning roles.
- Load order in `packages/web/src/main.tsx` (and mirrored in `packages/web/.storybook/preview.ts`) is `token.css`, `reset.css`, `global.css`. `reset.css` is a trimmed Tailwind v4 Preflight; `global.css` holds document-level defaults (`font-sans`, `--type-body-*`, `font-size-adjust: from-font`, `font-synthesis: none`).
- Colors use `light-dark()` with `color-scheme`. Set `data-theme="light"` or `data-theme="dark"` on `<html>` to override the system theme.
- Fonts (`Google Sans`, `Newsreader`, and `JetBrains Mono` via `@fontsource-variable/*`, Latin subset only) live in `packages/web/src/styles/fonts/*.css` and load lazily through `packages/web/src/lib/fonts.ts` (`scheduleDefaultFonts`, `ensureFontRole`, `applyFontPreset`) and `useFontRole`: `sans` loads during browser idle time, while `mono` and `serif` load on demand when matching surfaces mount. Because `global.css` sets `font-synthesis: none`, every weight and style must be covered by the active variable face.

### CSS Nesting

CSS Modules use native nesting (no preprocessor). Follow these rules:

- **Nest by DOM containment**: Nest `.child` under `.parent` only when TSX or story markup proves containment; never nest siblings or portaled elements. Use `&:` and `&[...]` for states on the same element (only use `&.otherClass` to match an existing compound selector's specificity). Nest `@media`, `@supports`, and `@container` inside a block only when all inner rules share that block. Keep declaration order so nesting never breaks the cascade.
- **Protect class specificity**: Keep classes passed to child components via `className` (`Button`, `Input`, `IconButton`, `ScrollArea`, ...) and co-located modifier presets (such as size or radius classes) at the top level so they keep `(0,1,0)` specificity. For a public `className` accepted by a component (`Dialog`, `Menu`, ...), wrap ancestors with `:where()` so nesting adds zero specificity (`.viewport { :where(.popup) { ... } }`).
- **Header tree sketch**: Start every `*.module.css` file with an ASCII tree (`├─`, `└─`, `│`) of its authored CSS nesting (use one line for single-class modules), and update it in the same change when nesting changes. See [ScrollArea.module.css](../packages/web/src/components/ScrollArea/ScrollArea.module.css) for the canonical format.

## Viewport and Keyboard

- `packages/web/src/main.tsx` listens to `visualViewport` and writes `--vv-height`, `--vv-offset-top`, `--kb-inset`, and `data-keyboard-open="true"` on `<html>`.
- Pages use `--kb-inset` for bottom actions and scroll clearance. Never combine `--kb-inset` with `--vv-height` on the same layout, or the keyboard inset applies twice.

## Storybook and Testing

- Stories live beside components as `*.stories.tsx`. `packages/web/.storybook/main.ts` enables `@storybook/addon-docs`, `@storybook/addon-a11y` (`test: "error"` in `preview.ts`, opt-out via `parameters: { a11y: { test: "todo" } }`), and `@storybook/addon-vitest`.
- Story-only helpers live in `packages/web/src/storybook/`: `requireElement` and `requireViewport` throw with the missing node's name, `sid` parses a story session id, `DarkTheme` and `LightTheme` pin the document theme for a story, and `storyFrame.module.css` provides the shared transcript column frame.
- `packages/web/vitest.config.ts` defines the `unit` (`*.test.ts` in Node) and `storybook` (Chromium via Playwright) projects. Run Storybook browser tests inside `devenv shell` and stop the Storybook dev server first so workers do not contend for memory.

## Routing and Hooks

- `packages/web/src/router.tsx` creates one `createBrowserRouter` instance at module load (never in React state); the Node server falls back non-API paths to `index.html`. React Router 8 imports `RouterProvider` from `react-router/dom` and hooks/components from `react-router`.
- `AppLayout` (`packages/web/src/pages/AppLayout/`) is the root route owning shared chrome and the single-host auth gate (`checking` / `unauthenticated` / `authenticated`). The root `errorElement` renders `RouteError` outside `AppLayout`.
- `/workspace` (`WorkspaceLayout`) owns the workspace shell (sidebar/drawer, topbar, settings, new-session dialog, catalog sync) and renders the active chat column via `<Outlet />` so switching sessions never remounts the shell.
- Reusable component-free hooks live in `packages/web/src/hooks/<name>.ts` and are re-exported from `packages/web/src/hooks/index.ts`; import them via `@/hooks`. Component-scoped hooks stay in `components/<Name>/`; page-scoped hooks stay in `pages/<Name>/`.

## Formatting

- Component-free display helpers live in `packages/web/src/lib/` and are re-exported from `packages/web/src/lib/index.ts`; import them via `@/lib`. `Formatter` groups the duration, byte size, USD cost, token count and relative age formatters, `Fuzzy` exposes pi-tui-compatible fuzzy matching and filtering, and `Clipboard` owns clipboard text writes and image file reads. They take plain values and return strings so components and stores share one output. Domain-specific message composition (for example a compaction note or a truncation warning) stays with the store that owns the data.

## State, Cache, and Transport

- Store factories (`createAuthStore`, `createSessionStore`, `createWorkspaceStore`) live in `packages/web/src/stores/<name>/` with no cross-store imports or module-load side effects. Each domain exposes an `index.ts` barrel (`@/stores/auth`, `@/stores/session`, `@/stores/workspace`). `packages/web/src/stores/index.ts` (`createAppStores`) wires the singletons (`useAuthStore`, `useSessionStore`, `useWorkspaceStore`) and is the only app-wide store entry point.
- `packages/web/src/lib/cache/` owns `IndexedDbAppCache` (`appCache`, backed by `IndexedDbCoordinator` with in-memory fallback). Stores accept narrow interfaces (`SessionCache`, `WorkspaceCatalogCache`, `ClearableCache`), and sign-out, `401` responses, or `markUnauthorized()` (including `useWorkspaceSync`'s `authProbe`) trigger `clearAll()`.
- HTTP/WebSocket clients stay in `packages/web/src/lib/transport/`, consuming `HTTP_ENDPOINTS`, `WS_ENDPOINTS`, and wire decoders from `@pivia/protocol` (`websocket.ts` provides shared WebSocket helpers). Import them through `@/lib/transport`. Real-time streams use `packages/web/src/lib/sync/` (see [versioned_incremental_sync.md](versioned_incremental_sync.md)).

## Workspace Sync and Session View

- **Catalog sync (`useWorkspaceSync`)**: Hydrates stale catalog rows from IndexedDB on mount, subscribes to `/ws/workspace` for `SyncFrame<"catalog", CatalogSnapshot, CatalogDelta>`, reconnects with backoff (and wakes on visibility change), probes `/api/auth/status` after repeated closes, and exposes single-flight manual refresh via `GET /api/sessions`. Keep cached rows visible under a status banner during `reconnecting` or `failed`; show skeleton rows during `syncing` with `focusableWhenDisabled` on the refresh button.
- **Session binding (`useWorkspaceSession`)**: Parses `:sessionId` with `parseSessionId`, calls `connect(parsedId)` on change, and calls `disconnect()` for missing/invalid ids or unmount. `WorkspacePage` accepts an optional `sessionStore` prop for isolated tests and stories.
- **Transcript projection invariants**: Components never walk the entry tree directly. `projectSessionTranscript` (`packages/web/src/stores/session/projection.ts`) resolves active branch, compaction boundary, and `context_edit` replacements; `buildTranscript` (`packages/web/src/stores/session/transcript.ts`) folds entries plus `liveAssistantMessage` into user, skill, bash (`!` / `!!`), extension (`custom_message` via `CollapsibleBlock` with `tone="accent"`), note, and turn items.
- **Transcript module boundary**: Pages import `projectSessionTranscript`, `buildTranscript`, and the transcript view-model types from `@/stores/session`. The transcript component entry is `pages/Workspace/components/Transcript/index.ts`, which exposes `Transcript`, `collectQueuedEntries`, and `QueuedEntry`. `tool-details.ts`, `transcript-meta.ts`, `readers.ts`, and `skill-block.ts` are internal collaborators; import them directly only in a colocated test that targets their boundary parsing.
- **Tool display split**: `transcript.ts` classifies each call (`toolKind`) and derives its argument summary; display labels and icons live with the view in `ToolCallBlock/toolDisplay.ts`, while the model carries only the raw `toolName`.
- **Timing exclusivity**: `TranscriptTiming` is a discriminated union (`static` final duration vs `since` start timestamp) so callers cannot add live elapsed time to a snapshot duration twice. Only the trailing turn of an active runtime may show an unmatched tool call as `running`; historical unmatched calls are `error` (interrupted).
- **Page state order**: `selectWorkspaceView` (`packages/web/src/pages/Workspace/workspaceView.ts`) resolves `loading` -> `terminalError` (or cached `transcript` when closed with rows) -> `syncError` (or cached `transcript` with a retry banner) -> `empty` -> `transcript`.

## Toasts

- `packages/web/src/lib/toast.ts` exports the single `toastManager`, `showError`, and `showWarning`. `main.tsx` mounts the single `ToastProvider` at top center; never mount a second provider.
