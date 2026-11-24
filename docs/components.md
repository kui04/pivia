# Components

## General Rules

- Check the Base UI index at `https://base-ui.com/llms.txt` before you build new UI. Wrap `@base-ui/react/<name>` when a matching primitive exists instead of re-implementing its behaviour.
- Base UI owns modal focus trapping, scroll lock, `Escape` handling, focus return, and overlay keyboard navigation across `Menu`, `Dialog`, `AlertDialog`, `Drawer`, `Select`, and `Toast`. Do not re-implement those mechanics in wrappers.
- Compose class names with `cn` from `packages/web/src/lib/cn.ts`. The app does not use Tailwind, so do not add `tailwind-merge`.
- Write to the clipboard only through `packages/web/src/lib/clipboard.ts`. It tries `navigator.clipboard.writeText` first and falls back to `execCommand("copy")` in denied or non-secure contexts.

## Primitives and Layout

- **Icon** (`packages/web/src/components/Icon`): Route every icon through `Icon` instead of importing Lucide icons directly. It owns the box, glyph scale, and `aria-hidden`. `Checkbox` is the only exception: its 16px control box draws a 12px check directly. A lone icon aligned to a text edge sets `--icon-padding-inline-start: 0` in its own CSS class; only start padding drops (`24px - 4px = 20px` for `md`), so the caller must account for the narrower box.
- **LoadingIndicator**: Wraps Base UI Progress (`value={null}`) around an SVG ring inside `Icon`, so it shares `sm`, `no-container`, `md`, `lg`, and `xl` presets. `label` defaults to `"Loading"` unless `aria-labelledby` is set. Only the active arc group rotates, and the arc keeps a 25% minimum length to avoid collapsing at 16px.
- **ScrollArea**: Wraps Base UI Scroll Area with hidden native scrollbars and 6px overlay bars so content width never shifts. The horizontal bar stays visible while overflowing; the vertical bar appears on hover or scroll and hides after Base UI's idle timeout (500 ms in 1.9.0), or stays visible with a wider invisible hit area on touch devices. `CodeBlock`, Markdown tables, and display math must use `ScrollArea` instead of native `overflow-x: auto`. Only page-level scrollers (transcript, session sidebar, server directory browser) pass `landmark` to expose `role="region"`; repeated blocks keep `role="group"`.

## Overlays and Feedback

- **Menu**: Caller passes the trigger (usually `IconButton`). The popup animates opacity and scale with `--motion-duration-effects-fast` and `--motion-easing-standard`; never use raw durations or easings. Base UI skips animation for keyboard activation and dismiss closes. The positioner uses `--z-modal`: a menu inside a dialog or drawer mounts inside that modal's portal after its viewport so it stays above the scrim (`--z-dropdown` would place it underneath).
- **Dialog**: Base modal shell built on Base UI Dialog, sharing `DialogSurface.module.css` with `AlertDialog`. Callers compose `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogActions`, and `DialogClose`, plus any `Form` or buttons.
- **AlertDialog**: Semantic confirmation shell (`role="alertdialog"`, pointer dismissal disabled) with Cancel, Confirm, and a destructive variant. It closes on either action, so an asynchronous confirmation must control `open` and block closing in `onOpenChange` until the work finishes.
- **Drawer**: Edge-anchored modal panel (`left`, `right`, or `bottom`) used for the session sidebar and mobile sheets. Base UI focuses the panel on open to keep mobile virtual keyboards closed, and skips disabled primary actions in tab order. The portal mounts to `document.body` outside `#root` safe-area padding, so the viewport adds `env(safe-area-inset-*)` and uses the larger of the bottom safe area and `--kb-inset`. A bottom sheet caps its height to `min(85dvh, 42rem)` plus the bleed; callers with forms (such as `CreateSessionDialog`) override `max-block-size: 100%` on their popup and scroll the form body. The portal uses `keepMounted` so closed content preserves search and scroll state. Use `useInsideDrawer` to prevent page-level gestures from claiming the swipe area.
- **Toast**: `ToastProvider` mounts once at the app root (`packages/web/src/main.tsx`, top center) with the shared manager from `packages/web/src/lib/toast.ts`. Do not mount a second provider; report errors and warnings through `showError` and `showWarning`. `useToast` from `useToast.ts` uses `info`, `success`, `warning`, and `error` status icons; `warning` and `error` default to persistent (`timeout: 0`) unless an explicit `timeout` is passed. Stack variables use `--toast-stack-*` so they do not collide with Base UI's `--toast-*` variables, and collapsed back toasts hide their close button to protect tab order.

## Forms

- **Form**: Wraps Base UI Form for vertical layout, submit validation, focusing the first invalid control, and external `errors`. `onFormSubmit` receives values from registered `Field` controls; native `onSubmit` remains available.
- **Fieldset**: Wraps Base UI Fieldset with a required `legend`. Disabling it disables all `Field` descendants through Base UI context.
- **Field**: Connects `label`, `description`, and `error` to one control and exposes `data-invalid` / `data-disabled`. Pass `nativeLabel={false}` for button triggers such as `Select`. An explicit `error` marks the field invalid and replaces `description` without layout shift while the hidden description preserves row height; fields without either reserve no message row. `Field` must live inside `Form` for submit validation.
- **Button**: Owns `variant`, `size`, `radius`, and a 48px minimum height on coarse primary pointers while preserving Base UI `disabled` and `render` behaviour.
- **Input**: Bare text-field styling over Base UI Input. Always wrap in `Field` when a label, description, or validation error is needed.
- **Select**: Bare single-select control over Base UI Select. Wrap in `Field` with `nativeLabel={false}`. Uses `items` for selected labels, copies the trigger's `aria-labelledby` to the listbox, defaults to `modal={false}` so it works inside `Dialog`, and uses `--z-modal` (its portal must stay ordered after the dialog portal).
- **Checkbox**: Renders a native `<label>` beside a 16px box with a direct 12px check. Focus stays on the visible `role="checkbox"` element. Because it is not a `Field`, `Form.onFormSubmit` does not collect it; use native form submission when needed.

## Rich Content and Media

- **CodeBlock**: Wraps Shiki (`light-plus` / `dark-plus`) and keeps `streaming` blocks plain until complete. Diff input keeps signs in a sticky gutter. Toolbar wraps lines and copies via `lib/clipboard.ts`.
- **Markdown**: Renders model output with GFM, KaTeX, and single-newline breaks, routing fenced code to `CodeBlock`, tables and display math to `ScrollArea`, and images to `Image` + one message-level `ImageViewer` (images inside links stay static). `remarkCurrency` prevents prices such as `$5` from parsing as math while preserving `$x$` and `$$...$$`. External links open via `onOpenLink` so the session never navigates away; `#fragment` links scroll smoothly and move focus. `Markdown.module.css` is the deliberate exception to UI tokens and owns local `--md-*` scales and colors; do not replace them with global UI tokens.
- **Image & ImageViewer**: `Image` is presentational (plus optional trigger) and owns no viewer state. `ImageViewer` is a controlled single-image dialog with `react-zoom-pan-pinch`, `--color-viewer-backdrop`, and immediate zoom controls (only the dialog transition is timed). Multi-image galleries are out of scope.
