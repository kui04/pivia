import { assertNever } from "@pivia/protocol";
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
import { useId, useMemo, useState, type ReactElement } from "react";

import { CodeBlock, Icon, IconButton, Image, ScrollArea } from "@components";
import { cn } from "@/lib/cn";
import {
    formatToolDuration,
    type TranscriptToolCallStep,
    type TranscriptToolKind,
    type TranscriptToolPreview,
    type TranscriptToolWarning,
} from "@/stores/session/transcript";

import { useAutoScroll } from "../../useAutoScroll";
import { useCopyFeedback } from "../../useCopyFeedback";
import { useLiveDuration } from "../../useLiveDuration";
import styles from "./ToolCallBlock.module.css";

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
    /** Called after copying the tool output or preview code succeeds. */
    onCopy?: ((text: string) => void) | undefined;
    /** Initial line-wrap state for tool output inside the card. */
    defaultWrapped?: boolean | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

function renderWarningItem(warning: TranscriptToolWarning, index: number): ReactElement {
    switch (warning.kind) {
        case "fullOutput":
            return (
                <p key={`fullOutput-${index}`} className={styles.notice}>
                    Full output: <code>{warning.path}</code>
                </p>
            );
        case "notice":
            return (
                <p key={`notice-${index}`} className={styles.notice}>
                    {warning.message}
                </p>
            );
        default:
            return assertNever(warning);
    }
}

function renderPreviewCodeBlock(
    preview: Exclude<TranscriptToolPreview, { kind: "none" }>,
    streaming: boolean,
    defaultWrap: boolean,
    onCopy: ((text: string) => void) | undefined,
): ReactElement {
    const codeProps =
        preview.kind === "diff"
            ? { code: preview.diff, language: "diff" as const, lineNumbers: false, startLine: 1 }
            : {
                  code: preview.code,
                  language: preview.language,
                  lineNumbers: true,
                  startLine: preview.startLine,
              };

    return (
        <CodeBlock
            {...codeProps}
            streaming={streaming}
            defaultWrap={defaultWrap}
            scrollClassName={styles.previewScroll}
            viewportClassName={styles.previewViewport}
            {...(onCopy !== undefined ? { onCopy } : {})}
        />
    );
}

/**
 * Secondary collapsible row and bounded output card for a single tool invocation.
 *
 * The header shows a tool icon, the accented label, a single-line argument summary and live
 * progress or duration. Expanded content shows either a highlighted diff/code preview (`edit`,
 * `write`, `read`) or a bounded monospace output card, plus any truncation warnings and image
 * attachments.
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
    const { status: copyStatus, copy } = useCopyFeedback(onCopy);
    const panelId = useId();

    const open = controlledOpen ?? uncontrolledOpen;
    const isRunning = step.status === "running";
    const isError = step.status === "error";
    const hasRichPreview = step.preview.kind !== "none";

    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({
        enabled: open && !hasRichPreview,
        streaming: isRunning,
    });
    const liveDurationMs = useLiveDuration(step.timing, 100);

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
        () => (open && !hasRichPreview && !hasOutput && hasArguments ? JSON.stringify(step.arguments, null, 2) : ""),
        [hasArguments, hasOutput, hasRichPreview, open, step.arguments],
    );
    const hasCopyable = hasOutput || step.argumentsError !== null || hasArguments;
    const formattedDuration = liveDurationMs !== null ? formatToolDuration(liveDurationMs) : null;
    const statusText = copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "";

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
        copy(buildCopyableText());
    };

    const imagesSection =
        step.images.length > 0 ? (
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
        ) : null;

    const warningsSection =
        step.warnings.length > 0 ? (
            <div className={styles.notices}>
                {step.warnings.map((warning, index) => renderWarningItem(warning, index))}
            </div>
        ) : null;

    const renderBodyContent = (preview: TranscriptToolPreview): ReactElement => {
        switch (preview.kind) {
            case "diff":
            case "code":
                return (
                    <div className={styles.previewStack}>
                        {step.argumentsError !== null ? (
                            <p className={styles.errorNote}>{step.argumentsError}</p>
                        ) : null}
                        {renderPreviewCodeBlock(preview, isRunning, defaultWrapped, onCopy)}
                        {warningsSection !== null ? (
                            <div className={styles.previewNotices}>{warningsSection}</div>
                        ) : null}
                        {imagesSection}
                    </div>
                );
            case "none":
                return (
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
                                {copyStatus === "copied" ? (
                                    <Check strokeWidth={1.75} />
                                ) : copyStatus === "failed" ? (
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

                            {imagesSection}
                        </ScrollArea>

                        {warningsSection}
                    </div>
                );
            default:
                return assertNever(preview);
        }
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
                        {renderBodyContent(step.preview)}
                    </div>
                </div>
            </div>
        </div>
    );
}
