import {
    Check,
    ChevronRight,
    Code,
    Copy,
    FilePen,
    FilePlus,
    FileText,
    FolderOpen,
    FolderSearch,
    Search,
    SearchCode,
    Terminal,
    Wrench,
    WrapText,
    X,
    type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactElement } from "react";

import { Icon, IconButton, Image, ScrollArea } from "@components";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { formatToolDuration, type TranscriptToolCallStep, type TranscriptToolKind } from "@/stores/session/transcript";

import { useAutoScroll } from "../../useAutoScroll";
import { useLiveDuration } from "../../useLiveDuration";
import styles from "./ToolCallBlock.module.css";

/** How long the copy button keeps its success or failure icon. */
const COPY_FEEDBACK_MS = 2000;

type CopyStatus = "idle" | "copied" | "failed";

/** Maps Pi built-in tools to dedicated icons and groups all custom tools under Wrench. */
const TOOL_ICONS: Record<TranscriptToolKind, LucideIcon> = {
    bash: Terminal,
    powershell: Terminal,
    read: FileText,
    write: FilePlus,
    edit: FilePen,
    grep: Search,
    find: FolderSearch,
    ls: FolderOpen,
    codemode: Code,
    tool_search: SearchCode,
    generic: Wrench,
};

/** Props of {@link ToolCallBlock}. */
export type ToolCallBlockProps = {
    /** Tool call step projected by the transcript model. */
    step: TranscriptToolCallStep;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when the user toggles the block. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Called after copying the tool output succeeds. */
    onCopy?: ((text: string) => void) | undefined;
    /** Initial line-wrap state for tool output inside the card. */
    defaultWrapped?: boolean | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Secondary collapsible row and bounded output card for a single tool invocation.
 *
 * The header shows a tool icon, the accented label, a single-line argument summary and live
 * progress or duration. Expanded content stays inside a capped scroll viewport with edge fades,
 * streaming bottom follow, and wrap and copy actions.
 *
 * @param props - Tool call step and optional expansion and copy controls.
 */
export function ToolCallBlock({
    step,
    defaultOpen = false,
    open: controlledOpen,
    onOpenChange,
    onCopy,
    defaultWrapped = false,
    className,
}: ToolCallBlockProps): ReactElement {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const [wrapped, setWrapped] = useState(defaultWrapped);
    const [copy, setCopy] = useState<{ status: CopyStatus; pulse: number }>({ status: "idle", pulse: 0 });
    const panelId = useId();

    const open = controlledOpen ?? uncontrolledOpen;
    const isRunning = step.status === "running";
    const isError = step.status === "error";

    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({ enabled: open, streaming: isRunning });
    const liveDurationMs = useLiveDuration(step.timing, 100);

    useEffect(() => {
        if (copy.status === "idle") {
            return;
        }

        // The pulse restarts the timeout when the user copies again before the feedback resets.
        const timer = window.setTimeout(
            () => setCopy((value) => ({ status: "idle", pulse: value.pulse })),
            COPY_FEEDBACK_MS,
        );
        return () => window.clearTimeout(timer);
    }, [copy.status, copy.pulse]);

    const handleToggle = () => {
        const next = !open;
        if (controlledOpen === undefined) {
            setUncontrolledOpen(next);
        }
        onOpenChange?.(next);
    };

    const ToolIcon = TOOL_ICONS[step.toolKind];
    const hasOutput = step.output.length > 0;
    const hasArguments = Object.keys(step.arguments).length > 0;
    // A collapsed block or one with output never renders the argument JSON, and the running timer
    // re-renders every 100 ms, so serialize only when the expanded card actually shows it.
    const formattedArguments = useMemo(
        () => (open && !hasOutput && hasArguments ? JSON.stringify(step.arguments, null, 2) : ""),
        [hasArguments, hasOutput, open, step.arguments],
    );
    const hasCopyable = hasOutput || step.argumentsError !== null || hasArguments;
    const formattedDuration = liveDurationMs !== null ? formatToolDuration(liveDurationMs) : null;
    const statusText = copy.status === "copied" ? "Copied" : copy.status === "failed" ? "Copy failed" : "";

    /**
     * Build the copy payload on demand: with output it is the output, and only an argument-only card
     * needs the JSON that the collapsed render skipped.
     */
    const buildCopyableText = (): string => {
        if (hasOutput) {
            return step.argumentsError !== null ? `${step.argumentsError}\n${step.output}` : step.output;
        }
        if (step.argumentsError !== null) {
            return step.argumentsError;
        }
        return hasArguments ? JSON.stringify(step.arguments, null, 2) : "";
    };

    const handleCopy = () => {
        const text = buildCopyableText();
        if (text.length === 0) {
            return;
        }

        copyText(text).then(
            () => {
                setCopy((value) => ({ status: "copied", pulse: value.pulse + 1 }));
                onCopy?.(text);
            },
            () => setCopy((value) => ({ status: "failed", pulse: value.pulse + 1 })),
        );
    };

    return (
        <div className={cn(styles.root, className)}>
            <button
                type="button"
                className={styles.trigger}
                aria-expanded={open}
                aria-controls={panelId}
                data-status={step.status}
                onClick={handleToggle}
            >
                <Icon size="no-container" className={cn(styles.icon, isError && styles.iconError)}>
                    <ToolIcon strokeWidth={1.75} />
                </Icon>
                <span className={styles.name}>{step.label}</span>
                <span className={styles.summary}>{step.summary}</span>
                {formattedDuration !== null ? (
                    <span className={styles.duration} data-running={isRunning ? "true" : undefined}>
                        {formattedDuration}
                    </span>
                ) : null}
                <Icon size="no-container" className={styles.chevron} data-open={open ? "true" : undefined}>
                    <ChevronRight strokeWidth={1.75} />
                </Icon>
            </button>

            <div id={panelId} className={styles.collapse} data-open={open ? "true" : undefined}>
                <div className={styles.collapseInner} inert={!open} aria-hidden={!open}>
                    <div className={styles.body}>
                        <div className={styles.rail} aria-hidden="true" />
                        <div
                            className={styles.card}
                            data-status={step.status}
                            data-fade-top={fadeTop ? "true" : undefined}
                            data-fade-bottom={fadeBottom ? "true" : undefined}
                        >
                            <div className={styles.toolbar}>
                                <IconButton
                                    label="Wrap lines"
                                    aria-pressed={wrapped}
                                    onClick={() => setWrapped((prev) => !prev)}
                                >
                                    <WrapText strokeWidth={1.75} />
                                </IconButton>
                                <IconButton label="Copy output" disabled={!hasCopyable} onClick={handleCopy}>
                                    {copy.status === "copied" ? (
                                        <Check strokeWidth={1.75} />
                                    ) : copy.status === "failed" ? (
                                        <X strokeWidth={1.75} />
                                    ) : (
                                        <Copy strokeWidth={1.75} />
                                    )}
                                </IconButton>
                            </div>
                            <span className={styles.status} role="status">
                                {statusText}
                            </span>

                            <ScrollArea
                                label={`${step.label} output`}
                                viewportRef={viewportRef}
                                className={styles.scroll}
                                viewportClassName={cn(
                                    styles.viewport,
                                    fadeTop && styles.fadeTop,
                                    fadeBottom && styles.fadeBottom,
                                )}
                                contentClassName={cn(styles.content, wrapped && styles.contentWrapped)}
                            >
                                {step.argumentsError !== null ? (
                                    <p className={styles.errorNote}>{step.argumentsError}</p>
                                ) : null}

                                {hasOutput ? (
                                    <pre className={styles.output} data-wrapped={wrapped ? "true" : undefined}>
                                        {step.output}
                                    </pre>
                                ) : step.images.length === 0 && step.argumentsError === null ? (
                                    hasArguments ? (
                                        <pre className={styles.output} data-wrapped={wrapped ? "true" : undefined}>
                                            {formattedArguments}
                                        </pre>
                                    ) : (
                                        <p className={styles.output} data-muted="true">
                                            {isRunning ? "Running..." : "No output"}
                                        </p>
                                    )
                                ) : null}

                                {step.images.length > 0 ? (
                                    <div className={styles.images}>
                                        {step.images.map((image, index) => (
                                            <Image
                                                key={`${step.id}-image-${index}`}
                                                src={`data:${image.mimeType};base64,${image.data}`}
                                                alt={`${step.label} output image ${index + 1}`}
                                                className={styles.image}
                                            />
                                        ))}
                                    </div>
                                ) : null}
                            </ScrollArea>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
