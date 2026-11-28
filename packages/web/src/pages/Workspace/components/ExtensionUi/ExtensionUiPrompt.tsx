import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialogRequest } from "@pivia/protocol";
import { useState, type ReactElement } from "react";

import { useNow } from "@/hooks";

import { remainingSeconds } from "./countdown";
import { ExtensionUiDialog } from "./ExtensionUiDialog";

/** Props of the countdown wrapper around {@link ExtensionUiDialog}. */
export interface ExtensionUiPromptProps {
    /** Whether the modal portal is visible; keep mounted while pending so the countdown persists. */
    readonly open: boolean;
    /** Oldest pending dialog of one session. Mount with `key={request.id}` so the countdown restarts. */
    readonly request: ExtensionDialogRequest;
    /** True after this client sent an answer or while the connection is not open. */
    readonly pending: boolean;
    /** Sending failure to show without closing the dialog. */
    readonly error: string | null;
    readonly onReply: (reply: RpcExtensionUIResponse) => void;
    readonly onMinimize: () => void;
}

/**
 * Counts down one extension dialog's own timeout.
 *
 * The receipt time is captured when this component mounts, which is when the request first becomes
 * the head of the queue. Keeping it mounted with `open={false}` preserves the countdown and draft
 * across minimize or focus changes. The server owns the real timer and closes the dialog with
 * `ui_resolved`.
 */
export function ExtensionUiPrompt({
    open,
    request,
    pending,
    error,
    onReply,
    onMinimize,
}: ExtensionUiPromptProps): ReactElement {
    const timeoutMs = "timeout" in request ? request.timeout : undefined;
    const hasCountdown = timeoutMs !== undefined && timeoutMs > 0;
    const [startedAtMs] = useState(() => Date.now());
    const nowMs = useNow(open && hasCountdown ? 1_000 : null);
    const seconds = open && hasCountdown ? remainingSeconds(timeoutMs, startedAtMs, nowMs) : null;

    return (
        <ExtensionUiDialog
            open={open}
            request={request}
            pending={pending}
            error={error}
            remainingSeconds={seconds}
            onReply={onReply}
            onMinimize={onMinimize}
        />
    );
}
