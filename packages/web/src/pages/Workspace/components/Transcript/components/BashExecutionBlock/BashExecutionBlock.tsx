import { assertNever } from "@pivia/protocol";
import { Check, Copy, Terminal, WrapText, X } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Icon, IconButton, ScrollArea } from "@components";
import { copyFeedbackText, useCopyFeedback } from "@/hooks";
import { cn } from "@/lib";
import type { TranscriptBashItem, TranscriptBashStatus } from "@/stores/session/transcript";

import { useAutoScroll } from "../../useAutoScroll";
import styles from "./BashExecutionBlock.module.css";

/** Props of {@link BashExecutionBlock}. */
export type BashExecutionBlockProps = {
    /** User `!` command record projected by the transcript model. */
    item: TranscriptBashItem;
    /** Called after copying the output succeeds. */
    onCopy?: ((text: string) => void) | undefined;
    /** Initial line-wrap state for the output. */
    defaultWrapped?: boolean | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

function formatStatus(status: TranscriptBashStatus): string {
    switch (status.kind) {
        case "succeeded":
            // A successful command needs no badge; its output speaks for itself.
            return "";
        case "failed":
            return `exited ${status.exitCode}`;
        case "cancelled":
            return "cancelled";
        case "noExitCode":
            return "no exit code";
        default:
            return assertNever(status);
    }
}

/**
 * One `!` command the reader ran between turns: command header, bounded output and result state.
 *
 * The record is written after the command ends, so it never shows a running state. Output keeps
 * its line structure with LF endings, loses terminal escapes, and can switch between horizontal
 * scrolling and wrapping; a truncated record names the file holding the full output.
 *
 * @param props - Command record and optional wrap and copy controls.
 */
export function BashExecutionBlock({
    item,
    onCopy,
    defaultWrapped = false,
    className,
}: BashExecutionBlockProps): ReactElement {
    const [wrapped, setWrapped] = useState(defaultWrapped);
    const { status: copyStatus, copy } = useCopyFeedback(onCopy);
    // The record never grows, so the viewport only needs scroll listeners for the edge masks.
    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({ streaming: false });

    const statusText = formatStatus(item.status);
    const copyStatusText = copyFeedbackText(copyStatus);
    const hasOutput = item.output.length > 0;
    const outputLabel = item.command.trim() !== "" ? `${item.command} output` : "Command output";

    const handleCopy = () => {
        copy(item.output);
    };

    return (
        <div
            className={cn(styles.root, className)}
            data-status={item.status.kind}
            data-context={item.excludeFromContext ? "excluded" : undefined}
            data-fade-top={fadeTop ? "true" : undefined}
            data-fade-bottom={fadeBottom ? "true" : undefined}
        >
            <div className={styles.header}>
                <Icon size="sm" className={styles.icon}>
                    <Terminal strokeWidth={1.75} />
                </Icon>
                <code className={styles.command}>
                    {item.command}
                    {statusText !== "" ? <span className={styles.status}>{` · ${statusText}`}</span> : null}
                    {item.excludeFromContext ? <span className={styles.context}>{" · not in context"}</span> : null}
                </code>
                <div className={styles.meta}>
                    <IconButton label="Wrap lines" aria-pressed={wrapped} onClick={() => setWrapped((prev) => !prev)}>
                        <WrapText strokeWidth={1.75} />
                    </IconButton>
                    <IconButton label="Copy output" disabled={!hasOutput} onClick={handleCopy}>
                        {copyStatus === "copied" ? (
                            <Check strokeWidth={1.75} />
                        ) : copyStatus === "failed" ? (
                            <X strokeWidth={1.75} />
                        ) : (
                            <Copy strokeWidth={1.75} />
                        )}
                    </IconButton>
                </div>
            </div>

            <ScrollArea
                label={outputLabel}
                viewportRef={viewportRef}
                className={styles.scroll}
                viewportClassName={cn(styles.viewport, fadeTop && styles.fadeTop, fadeBottom && styles.fadeBottom)}
                contentClassName={cn(styles.content, wrapped && styles.contentWrapped)}
            >
                {hasOutput ? (
                    <pre className={styles.output} data-wrapped={wrapped ? "true" : undefined}>
                        {item.output}
                    </pre>
                ) : (
                    <p className={styles.empty}>No output</p>
                )}
            </ScrollArea>

            {item.truncation.kind === "truncated" ? (
                <p className={styles.notice}>
                    Output truncated.
                    {item.truncation.fullOutputPath !== null ? (
                        <>
                            {" "}
                            Full output: <code>{item.truncation.fullOutputPath}</code>
                        </>
                    ) : null}
                </p>
            ) : null}

            <span className={styles.visuallyHidden} role="status">
                {copyStatusText}
            </span>
        </div>
    );
}
