import { useEffect, useState } from "react";

import { copyText } from "@/lib";

/** How long the copy control keeps its success or failure state. */
const COPY_FEEDBACK_MS = 2000;

/** Copy control state after the last attempt: idle, or the result shown on the icon. */
export type CopyFeedbackStatus = "idle" | "copied" | "failed";

/** State returned by {@link useCopyFeedback}. */
export type CopyFeedback = {
    readonly status: CopyFeedbackStatus;
    /** Copy text to the clipboard; an empty string is ignored. */
    readonly copy: (text: string) => void;
};

/**
 * Announcement for the last copy attempt.
 *
 * The icon carries the same state visually, so the live region repeats it for assistive
 * technology only. The exhaustive switch makes a new status a compile error instead of an empty
 * announcement.
 */
export function copyFeedbackText(status: CopyFeedbackStatus): string {
    switch (status) {
        case "idle":
            return "";
        case "copied":
            return "Copied";
        case "failed":
            return "Copy failed";
    }
}

/**
 * Drive one copy control.
 *
 * The pulse counter restarts the timeout, so copying again before the icon resets keeps the
 * feedback visible instead of letting the first timer clear it. An empty payload never reaches the
 * clipboard, so a disabled control and a no-op call behave the same.
 *
 * @param onCopied - Called with the text after a successful copy.
 * @returns The current status and the copy action.
 */
export function useCopyFeedback(onCopied?: (text: string) => void): CopyFeedback {
    const [feedback, setFeedback] = useState<{ readonly status: CopyFeedbackStatus; readonly pulse: number }>({
        status: "idle",
        pulse: 0,
    });

    useEffect(() => {
        if (feedback.status === "idle") {
            return;
        }

        const timer = window.setTimeout(
            () => setFeedback((value) => ({ status: "idle", pulse: value.pulse })),
            COPY_FEEDBACK_MS,
        );
        return () => window.clearTimeout(timer);
    }, [feedback.status, feedback.pulse]);

    const copy = (text: string): void => {
        if (text.length === 0) {
            return;
        }

        copyText(text).then(
            () => {
                setFeedback((value) => ({ status: "copied", pulse: value.pulse + 1 }));
                onCopied?.(text);
            },
            () => setFeedback((value) => ({ status: "failed", pulse: value.pulse + 1 })),
        );
    };

    return { status: feedback.status, copy };
}
