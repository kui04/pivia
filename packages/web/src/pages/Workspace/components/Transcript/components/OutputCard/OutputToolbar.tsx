import { Check, Copy, WrapText, X } from "lucide-react";
import type { ReactElement } from "react";

import { IconButton, VisuallyHidden } from "@components";
import { copyFeedbackText, type CopyFeedbackStatus } from "@/hooks";

/** Props of {@link OutputToolbar}. */
export type OutputToolbarProps = {
    /** True while the output wraps instead of scrolling sideways. */
    wrapped: boolean;
    /** Toggles the wrap state. */
    onToggleWrapped: () => void;
    /** State of the last copy attempt; the icon and the live region show it. */
    copyStatus: CopyFeedbackStatus;
    /** Copies the caller-provided payload. */
    onCopy: () => void;
    /** Disables the copy control when the card holds nothing to copy. */
    copyDisabled?: boolean | undefined;
    /** Accessible name of the copy control. Defaults to "Copy output". */
    copyLabel?: string | undefined;
};

/**
 * Wrap and copy controls shared by the transcript output cards.
 *
 * The caller owns the row that holds it, because a tool card overlays the controls on its output
 * while a command card keeps them in its header. The live region sits with the buttons, so the
 * icon and the announcement always describe the same attempt.
 */
export function OutputToolbar({
    wrapped,
    onToggleWrapped,
    copyStatus,
    onCopy,
    copyDisabled = false,
    copyLabel = "Copy output",
}: OutputToolbarProps): ReactElement {
    return (
        <>
            <IconButton label="Wrap lines" aria-pressed={wrapped} onClick={onToggleWrapped}>
                <WrapText strokeWidth={1.75} />
            </IconButton>
            <IconButton label={copyLabel} disabled={copyDisabled} onClick={onCopy}>
                {copyStatus === "copied" ? (
                    <Check strokeWidth={1.75} />
                ) : copyStatus === "failed" ? (
                    <X strokeWidth={1.75} />
                ) : (
                    <Copy strokeWidth={1.75} />
                )}
            </IconButton>
            <VisuallyHidden role="status">{copyFeedbackText(copyStatus)}</VisuallyHidden>
        </>
    );
}
