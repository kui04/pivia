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
  session scan) and renders the chat column through its `<Outlet />`, so the shell never remounts while the active
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
  `useSessionScan` in `Workspace/`. Moving those to `hooks/` would separate a rule from the only code that can call it.
- Do not add an index barrel to `packages/web/src/hooks/`; import the file directly.

## State and transport

- Zustand stores and their models live in `packages/web/src/stores/<name>/`; a store owns its persisted shape and the
  model helpers.
- HTTP and WebSocket client wrappers stay in `packages/web/src/lib/transport/` (using shared wire types from
  `packages/protocol`), because they are transport, not state.

## Session scan

- `useSessionScan` scans on connect/auth, when the document becomes visible, every five minutes and on manual refresh.
  One scan runs at a time, so a second refresh is ignored instead of queued.
- The scan phase records `manual`, so the sidebar replaces the rows with the skeleton only for a scan the user asked
  for. A background scan keeps the rows, because it would otherwise empty the sidebar every five minutes. The refresh
  button stays focusable while it is `aria-disabled`, so the click that disables it does not drop the focus.

## Notifications

- `packages/web/src/lib/notification.ts` owns the app's single notification manager plus `showError` and `showWarning`.
  `main.tsx` mounts the one `NotificationProvider` at the top center, so every route and outside-React caller reports
  to the same stack. Do not mount a second provider.

## Checks

- Typecheck, ESLint, unit tests and Storybook browser tests cover the frontend checks.
- Both Vitest projects run two files at a time (`maxWorkers: 2` at the root of `packages/web/vitest.config.ts`). Each
  worker loads the whole config, and each Storybook worker also loads the whole preview bundle, so one worker per core
  costs several GB. Run Storybook browser tests with the Storybook dev server stopped and not beside `prek run -a`, or
  concurrent bundles can exhaust the memory of a 16 GB host.
