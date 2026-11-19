# Components

- Before writing a component or any other UI, check the Base UI index at `https://base-ui.com/llms.txt`. If a
  suitable component or utility exists, wrap that part (`@base-ui/react/<name>`) instead of re-implementing its
  behaviour.
- Icons go through `packages/web/src/components/Icon`, not a bare Lucide import. It owns the box, the glyph size and
  the decorative `aria-hidden`, so icons keep one scale across components. The Checkbox check is the exception: the
  16px control box is already the container, so it draws a 12px check directly. A lone icon that must start on the
  same line as a text edge sets `--icon-padding-inline-start: 0` in its own CSS class; only the start padding goes,
  so the box gets narrower (20px for the default `md` size) and the caller must account for that in the label
  offset.
- `LoadingIndicator` wraps Base UI Progress in indeterminate mode (`value={null}`) and renders a circular SVG ring
  spinner inside `Icon`, so it shares the `sm`, `no-container`, `md`, `lg` and `xl` box and glyph presets. `label`
  defaults to `"Loading"` for the `progressbar` accessible name unless `aria-labelledby` is provided. Only the active
  arc group rotates, and the arc keeps a 25% minimum length; a shorter arc collapses into a dot and shimmers at 16px.
- Compose class names with `cn` from `packages/web/src/lib/cn.ts`. There is no Tailwind, so utility-conflict merging
  does not apply and `tailwind-merge` would be the wrong tool.
- `packages/web/src/lib/clipboard.ts` is the only place that writes to the clipboard: `navigator.clipboard.writeText`
  first, with the deprecated `execCommand` path as the fallback for denied or non-secure contexts.
- `ScrollArea` wraps Base UI's Scroll Area. Native scrollbars are hidden and 6px custom bars overlay the content, so no
  scrollbar gutter appears and the content width does not change. The horizontal bar stays visible while content
  overflows sideways; the vertical bar shows on hover or scroll and hides after the pointer leaves and Base UI's
  scroll idle timeout (500 ms in 1.9.0). On touch devices the vertical bar stays visible while scrollable and keeps a
  wider invisible hit area. `CodeBlock`, Markdown tables and display math use it for sideways overflow; do not
  reintroduce native `overflow-x: auto` there.
- `Markdown` renders model output with GFM, KaTeX and single-newline breaks. Fenced code goes through `CodeBlock`;
  `streaming` keeps those blocks plain until the answer ends. `remarkCurrency` keeps prices such as `$5` from becoming
  math, while `$x$` and `$$...$$` still render. External links open via `onOpenLink` (opening in a new tab/window) so
  the active session view never navigates away in place; `#fragment` links scroll smoothly to their target and move
  focus there. Markdown images go through `Image` and open one message-level `ImageViewer`; the Markdown title
  becomes the viewer caption. An image inside a link stays static so the link remains valid.
- `Markdown` is the deliberate exception to the token rule: its CSS module defines a local `--md-*` type scale,
  spacing and colors for the transcript, so do not pull the UI tokens back into it.
- `Menu` wraps Base UI Menu. The caller supplies the trigger (usually an `IconButton`); the popup, items
  and separators carry the overlay styles. Base UI owns keyboard navigation, typeahead, collision handling and
  focus return. The popup animates from opacity 0 and scale 0.98 with `--motion-duration-effects-fast` and
  `--motion-easing-standard`; never reintroduce a raw duration or easing. Base UI skips the animation for
  keyboard activation and dismiss closes. The positioner uses `--z-modal`: a menu inside a dialog or drawer
  mounts inside that modal's portal, after its viewport, so the shared modal layer keeps it above the panel
  that contains it; `--z-dropdown` would put it under the scrim.
- `AlertDialog` wraps Base UI Alert Dialog. The caller supplies an optional trigger, title, optional description and
  optional body; the component renders the backdrop, centered popup, built-in Cancel and Confirm actions and a
  destructive variant. Base UI owns the modal focus trap, scroll lock, Escape, focus return and the `alertdialog` role;
  pointer dismissal is disabled. The dialog closes on either action, so an asynchronous confirmation must control
  `open` and stop the close in `onOpenChange` until the work finishes.
- `Dialog` is the base layout shell built on Base UI Dialog. It renders only the backdrop, centered viewport and
  popup with the shared surface, spacing and motion styles. The caller composes the content from `DialogHeader`,
  `DialogTitle`, `DialogDescription`, `DialogActions` and `DialogClose`, and owns any `Form` and action buttons. Dialog
  and AlertDialog import `DialogSurface.module.css` for the shared overlay; `AlertDialog` is the semantic confirmation
  wrapper with its own actions. Base UI owns the modal focus trap, scroll lock, Escape and focus return.
- `Drawer` wraps Base UI Drawer as an edge-anchored modal panel, used for the session sidebar below the column
  breakpoint. Base UI owns the focus trap, the scroll lock, Escape, focus return and the swipe gesture, and focuses the
  panel on open, which keeps mobile virtual keyboards closed; a disabled primary action is skipped by the tab order, so
  the first Tab reaches the first usable control. The panel portals to `document.body`, outside the `#root` safe-area
  padding, so the viewport adds `env(safe-area-inset-*)` itself and keeps the larger of the safe area and `--kb-inset`
  at the bottom: while the keyboard is open it covers the home indicator. The portal stays mounted while the drawer is
  closed, so the content keeps its own state such as search text and scroll position; Base UI hides the panel and the
  backdrop from the accessibility tree meanwhile.
- `Field` wraps Base UI Field and supplies the label, description and error for one control. Base UI connects them
  to the control, tracks validity and exposes `data-invalid`/`data-disabled`. Pass `nativeLabel={false}` when the
  control is a Select trigger. An explicit `error` marks the field invalid and replaces the native message. The
  message row appears only when a description or error exists; an explicit error replaces the description in the
  same row without layout shift while the hidden description keeps the row height. A field with neither reserves no
  space; a native or explicit error adds the row when it appears. `Field` components must be inside `Form` for submit
  validation.
- `Fieldset` wraps Base UI Fieldset. The required legend names the group; a disabled fieldset disables every Field
  descendant through Base UI's context.
- `Form` wraps Base UI Form and supplies the vertical field layout. It validates registered Fields on submit, focuses
  the first invalid control and blocks submission until valid. `errors` carries external field errors and
  `onFormSubmit` receives the collected values; native `onSubmit` remains available.
- `Button` wraps Base UI Button and owns the emphasis, the compact default, the larger `lg` type and padding, the
  radius parameter and the touch target; a coarse primary pointer always gets the 48px height. It keeps Base UI's
  disabled and `render` behaviour.
- `Checkbox` wraps Base UI Checkbox. The 16px box draws its 12px check directly, because an `Icon` box would repeat
  the control box. The label is a native `<label>`, so the text and the box share one hit area; Base UI keeps focus
  on the visible `role="checkbox"` box, so the document focus rule draws the ring there. A bare checkbox submits
  through the native form; `Form.onFormSubmit` only collects registered Fields, so use native submission when that
  value must reach the callback. It is not a `Field`: the label sits beside the control, not above it.
- `Input` wraps Base UI Input as a bare control. Wrap it in `Field` for the label, description, error and validation
  wiring; `Input` only owns the text-field styling.
- `Select` wraps Base UI Select as a bare single-select control. Wrap it in `Field` with `nativeLabel={false}` for
  the label, description, error and validation wiring. It renders the hidden input for forms, uses `items` for the
  selected label, and copies the trigger's label reference to the listbox so the open popup keeps the Field label as
  its accessible name. It defaults to a non-modal popup so it can open inside a Dialog. The popup shares `--z-modal`
  with the dialog because its portal is appended after the dialog portal; keep that order when changing either layer.
- `Image` is the presentational image and optional trigger; it never owns viewer state. `ImageViewer` is a
  controlled single-image dialog built on Base UI Dialog with `react-zoom-pan-pinch` for zoom and pan. The dialog
  owns focus, scroll lock, Escape and focus return; zoom toolbar actions are immediate, so the dialog is the only
  timed transition. Its backdrop uses `--color-viewer-backdrop`. Galleries are deliberately out of scope.
- `Notification` wraps Base UI Toast. `NotificationProvider` renders the notification portal, fixed viewport and
  stack; callers use `useNotification` from `useNotification.ts` inside it. The viewport defaults to bottom-right and
  accepts the six logical `position` values; the stack mirrors its vertical side, and swipe directions follow the
  corner. It shows at most three notifications by default, expands on hover or focus and uses `info`, `success`,
  `warning` and `error` for semantic status icons. Base UI owns timers, focus, swipe and live-region semantics. A
  `warning` or an `error` has no default timeout, so it stays until the user dismisses it, while the other types use
  the provider timeout; an explicit `timeout` on one message always wins. The stack uses Base UI's `--toast-*`
  variables, which the library writes and this project cannot rename, plus the local `--notification-gap` and
  `--notification-peek`; motion comes from the token durations and easing, and the viewport uses `--z-notification`.
  A status icon sits on the close button's 24px line, so both glyphs share one centre, and it keeps only the start
  padding off so its glyph stays flush with the title. The close button stays visible and actionable at rest; behind
  notifications hide it while the stack is collapsed so it cannot take focus out of order. The app mounts one
  provider at the root with the manager from `packages/web/src/lib/notification.ts`, top center, and reports errors
  and warnings through `showError` and `showWarning`.
