import type { SessionUiState } from "@pivia/protocol";
import type { ReactElement } from "react";

import { cn } from "@/lib";

import styles from "./ExtensionUiChrome.module.css";

/** Largest widget body the session view renders; the rest is replaced by a truncation note. */
const MAX_WIDGET_LINES = 10;

/** Props of the extension chrome around the composer. */
export interface ExtensionUiChromeProps {
    readonly uiState: SessionUiState;
    /** `above` renders statuses and above-editor widgets; `below` renders below-editor widgets. */
    readonly placement: "above" | "below";
    readonly className?: string | undefined;
}

/** Collapse control characters so one status line stays on one line, like the terminal footer. */
function sanitizeStatusText(text: string): string {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

/**
 * Extension chrome around the composer: status lines above it, and plain-text widgets on the side
 * of the editor they asked for. The server caches the same state in the session snapshot, so a late
 * client renders it without replaying every delta.
 */
export function ExtensionUiChrome({ uiState, placement, className }: ExtensionUiChromeProps): ReactElement | null {
    const targetPlacement = placement === "above" ? "aboveEditor" : "belowEditor";
    const statusText =
        placement === "above"
            ? uiState.statuses
                  .map((status) => ({ key: status.key, text: sanitizeStatusText(status.text) }))
                  .filter((status) => status.text.length > 0)
                  .sort((first, second) => first.key.localeCompare(second.key))
                  .map((status) => status.text)
                  .join(" ")
            : "";
    const widgets = uiState.widgets.filter((widget) => widget.placement === targetPlacement && widget.lines.length > 0);

    if (statusText === "" && widgets.length === 0) {
        return null;
    }

    return (
        <div className={cn(styles.chrome, className)} data-placement={placement}>
            {statusText === "" ? null : (
                <p className={styles.statuses} title={statusText}>
                    {statusText}
                </p>
            )}
            {widgets.map((widget) => (
                <WidgetLines key={widget.key} lines={widget.lines} />
            ))}
        </div>
    );
}

function WidgetLines({ lines }: { readonly lines: readonly string[] }): ReactElement {
    const visible = lines.slice(0, MAX_WIDGET_LINES);
    const truncated = lines.length > MAX_WIDGET_LINES;

    return (
        <div className={styles.widget}>
            {visible.map((line, index) => (
                <p key={`${String(index)}-${line}`} className={styles.widgetLine}>
                    {line}
                </p>
            ))}
            {truncated ? <p className={styles.truncated}>... (widget truncated)</p> : null}
        </div>
    );
}
