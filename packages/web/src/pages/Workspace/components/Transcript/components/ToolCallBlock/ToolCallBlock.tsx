import { assertNever } from "@pivia/protocol";
import { Ban, Check, CircleDashed, X, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";

import { CodeBlock, Icon, Image, ScrollArea, VisuallyHidden } from "@components";
import { useCopyFeedback } from "@/hooks";
import { Formatter } from "@/lib";
import {
    type TranscriptNestedCallStatus,
    type TranscriptNestedCallsSummary,
    type TranscriptToolCallStep,
    type TranscriptToolPreview,
    type TranscriptToolWarning,
} from "@/stores/session/transcript";

import { useAutoScroll } from "../../useAutoScroll";
import { useLiveDuration } from "../../useLiveDuration";
import { Disclosure } from "../Disclosure/Disclosure";
import { useDisclosure } from "../Disclosure/useDisclosure";
import { Notice } from "../Notice/Notice";
import { OutputScroller } from "../OutputCard/OutputScroller";
import { OutputToolbar } from "../OutputCard/OutputToolbar";
import styles from "./ToolCallBlock.module.css";
import { toolDisplay } from "./toolDisplay";

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
            return <Notice key={`fullOutput-${index}`}>Full output: {warning.path}</Notice>;
        case "notice":
            return <Notice key={`notice-${index}`}>{warning.message}</Notice>;
        default:
            return assertNever(warning);
    }
}

const NESTED_STATUS_META: Record<TranscriptNestedCallStatus, { readonly icon: LucideIcon; readonly label: string }> = {
    ok: { icon: Check, label: "Succeeded" },
    error: { icon: X, label: "Failed" },
    cancelled: { icon: Ban, label: "Cancelled" },
    running: { icon: CircleDashed, label: "Running" },
    unfinished: { icon: CircleDashed, label: "Unfinished" },
};

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
                  startLine: preview.kind === "code" ? preview.startLine : 1,
              };

    return (
        <CodeBlock
            {...codeProps}
            streaming={streaming}
            defaultWrap={defaultWrap}
            scrollClassName={styles.previewScroll}
            viewportClassName={styles.previewViewport}
            onCopy={onCopy}
        />
    );
}

function renderNestedCallsSection(stepLabel: string, summary: TranscriptNestedCallsSummary): ReactElement {
    return (
        <div className={styles.nestedCalls}>
            {summary.calls.length > 0 ? (
                <ScrollArea
                    label={`${stepLabel} nested calls`}
                    className={styles.nestedCallsScroll}
                    viewportClassName={styles.nestedCallsViewport}
                    contentClassName={styles.nestedCallsContent}
                >
                    <ul className={styles.nestedCallList}>
                        {summary.calls.map((call, index) => {
                            const statusMeta = NESTED_STATUS_META[call.status];
                            const StatusIcon = statusMeta.icon;
                            const duration = call.durationMs !== null ? Formatter.duration(call.durationMs) : null;
                            const cost = call.cost !== null && call.cost > 0 ? Formatter.usdCost(call.cost) : null;
                            return (
                                <li key={`${call.id}-${index}`} className={styles.nestedCallItem}>
                                    <div className={styles.nestedCallRow}>
                                        <VisuallyHidden>{statusMeta.label}</VisuallyHidden>
                                        <Icon
                                            size="no-container"
                                            className={styles.nestedCallIcon}
                                            data-status={call.status}
                                        >
                                            <StatusIcon strokeWidth={1.75} />
                                        </Icon>
                                        <span className={styles.nestedCallName}>{call.name}</span>
                                        {call.args !== "" ? (
                                            <span className={styles.nestedCallArgs}>{call.args}</span>
                                        ) : null}
                                        {duration !== null ? (
                                            <span className={styles.nestedCallMeta}>{duration}</span>
                                        ) : null}
                                        {cost !== null ? <span className={styles.nestedCallMeta}>{cost}</span> : null}
                                    </div>
                                    {call.error !== null ? (
                                        <p className={styles.nestedCallError}>{call.error}</p>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </ScrollArea>
            ) : null}
            {summary.totalCost !== null || !summary.complete ? (
                <div className={styles.nestedCallsFooter}>
                    {summary.totalCost !== null ? (
                        <p className={styles.nestedCallsNote}>Model calls: {Formatter.usdCost(summary.totalCost)}</p>
                    ) : null}
                    {!summary.complete ? (
                        <p className={styles.nestedCallsNote}>Nested call log truncated or incomplete.</p>
                    ) : null}
                </div>
            ) : null}
        </div>
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
    const { open, onOpenChange: handleOpenChange } = useDisclosure({
        defaultOpen,
        open: controlledOpen,
        onOpenChange,
    });
    const [wrapped, setWrapped] = useState(defaultWrapped);
    const { status: copyStatus, copy } = useCopyFeedback(onCopy);

    const isRunning = step.status === "running";
    const isError = step.status === "error";
    const hasPreview = step.preview.kind !== "none";

    const hasOutput = step.output.length > 0;
    const hasArguments = Object.keys(step.arguments).length > 0;
    const showScriptOutputCard = step.preview.kind === "script" && (hasOutput || step.images.length > 0);
    const hasScrollableOutputCard = step.preview.kind === "none" || showScriptOutputCard;

    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({
        enabled: open && hasScrollableOutputCard,
        streaming: isRunning,
    });
    const liveDurationMs = useLiveDuration(step.timing, 1000);

    const { label, icon: ToolIcon } = toolDisplay(step.toolKind, step.toolName);
    // A collapsed block or one with output never renders the argument JSON, and the running timer
    // re-renders once per second, so serialize only when the expanded card actually shows it.
    const formattedArguments = useMemo(
        () => (open && !hasPreview && !hasOutput && hasArguments ? JSON.stringify(step.arguments, null, 2) : ""),
        [hasArguments, hasOutput, hasPreview, open, step.arguments],
    );
    const hasCopyable = hasOutput || (!hasPreview && (step.argumentsError !== null || hasArguments));
    const formattedDuration = liveDurationMs !== null ? Formatter.duration(liveDurationMs) : null;

    /**
     * Build the copy payload on demand: with output it is the output, and only an argument-only card
     * needs the JSON that the collapsed render skipped.
     */
    const buildCopyableText = (): string => {
        if (hasOutput) {
            return step.argumentsError !== null && !hasPreview ? `${step.argumentsError}\n${step.output}` : step.output;
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
                        alt={`${label} output image ${index + 1}`}
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

    const nestedCallsSection = step.nestedCalls !== null ? renderNestedCallsSection(label, step.nestedCalls) : null;

    const renderOutputCard = (allowArgumentsFallback: boolean): ReactElement => {
        const showArguments = allowArgumentsFallback && step.images.length === 0 && step.argumentsError === null;
        const text = hasOutput ? step.output : showArguments ? formattedArguments : "";
        const placeholder = showArguments && !hasArguments ? (isRunning ? "Running..." : "No output") : undefined;

        return (
            <div
                className={styles.card}
                data-status={step.status}
                data-fade-top={fadeTop ? "true" : undefined}
                data-fade-bottom={fadeBottom ? "true" : undefined}
            >
                <div className={styles.toolbar}>
                    <OutputToolbar
                        wrapped={wrapped}
                        onToggleWrapped={() => setWrapped((prev) => !prev)}
                        copyStatus={copyStatus}
                        onCopy={handleCopy}
                        copyDisabled={!hasCopyable}
                    />
                </div>

                <OutputScroller
                    label={`${label} output`}
                    text={text}
                    placeholder={placeholder}
                    before={
                        allowArgumentsFallback && step.argumentsError !== null ? (
                            <p className={styles.errorNote}>{step.argumentsError}</p>
                        ) : undefined
                    }
                    wrapped={wrapped}
                    overlayToolbar
                    viewportRef={viewportRef}
                    fadeTop={fadeTop}
                    fadeBottom={fadeBottom}
                >
                    {imagesSection}
                </OutputScroller>

                {warningsSection}
            </div>
        );
    };

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
                        {nestedCallsSection}
                        {warningsSection !== null ? (
                            <div className={styles.previewNotices}>{warningsSection}</div>
                        ) : null}
                        {imagesSection}
                    </div>
                );
            case "script":
                return (
                    <div className={styles.previewStack}>
                        {step.argumentsError !== null ? (
                            <p className={styles.errorNote}>{step.argumentsError}</p>
                        ) : null}
                        {renderPreviewCodeBlock(preview, isRunning, defaultWrapped, onCopy)}
                        {nestedCallsSection}
                        {showScriptOutputCard ? (
                            renderOutputCard(false)
                        ) : warningsSection !== null ? (
                            <div className={styles.previewNotices}>{warningsSection}</div>
                        ) : null}
                    </div>
                );
            case "none":
                return nestedCallsSection !== null ? (
                    <div className={styles.previewStack}>
                        {nestedCallsSection}
                        {renderOutputCard(true)}
                    </div>
                ) : (
                    renderOutputCard(true)
                );
            default:
                return assertNever(preview);
        }
    };

    return (
        <Disclosure
            open={open}
            onOpenChange={handleOpenChange}
            icon={ToolIcon}
            label={label}
            summary={step.summary}
            meta={formattedDuration ?? undefined}
            metaRunning={isRunning}
            tone={isError ? "error" : "primary"}
            className={className}
        >
            <div className={styles.body}>
                <div className={styles.rail} aria-hidden="true" />
                {renderBodyContent(step.preview)}
            </div>
        </Disclosure>
    );
}
