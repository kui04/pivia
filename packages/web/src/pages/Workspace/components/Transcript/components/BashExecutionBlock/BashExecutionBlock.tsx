import { assertNever } from "@pivia/protocol";
import { Terminal } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Icon } from "@components";
import { useCopyFeedback, useFontRole } from "@/hooks";
import { cn } from "@/lib";
import type { TranscriptBashItem, TranscriptBashStatus } from "@/stores/session";

import { useAutoScroll } from "../../useAutoScroll";
import { Notice } from "../Notice";
import { OutputScroller, OutputToolbar } from "../OutputCard";
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
    useFontRole("mono");
    const [wrapped, setWrapped] = useState(defaultWrapped);
    const { status: copyStatus, copy } = useCopyFeedback(onCopy);
    // The record never grows, so the viewport only needs scroll listeners for the edge masks.
    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({ streaming: false });

    const statusText = formatStatus(item.status);
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
                    <OutputToolbar
                        wrapped={wrapped}
                        onToggleWrapped={() => setWrapped((prev) => !prev)}
                        copyStatus={copyStatus}
                        onCopy={handleCopy}
                        copyDisabled={!hasOutput}
                    />
                </div>
            </div>

            <OutputScroller
                label={outputLabel}
                text={item.output}
                placeholder="No output"
                wrapped={wrapped}
                viewportRef={viewportRef}
                fadeTop={fadeTop}
                fadeBottom={fadeBottom}
            />

            {item.truncation.kind === "truncated" ? (
                <Notice className={styles.notice}>
                    Output truncated.
                    {item.truncation.fullOutputPath !== null ? ` Full output: ${item.truncation.fullOutputPath}` : null}
                </Notice>
            ) : null}
        </div>
    );
}
