import { assertNever } from "@pivia/protocol";
import { ChevronRight, Layers, MessageSquareText } from "lucide-react";
import { Fragment, useId, useState, type ReactElement } from "react";

import { Icon, Markdown } from "@components";
import { cn } from "@/lib/cn";
import { formatTurnDuration, type TranscriptStep, type TranscriptTurnItem } from "@/stores/session/transcript";

import { useLiveDuration } from "../../useLiveDuration";
import { ThinkingBlock } from "../ThinkingBlock/ThinkingBlock";
import { ToolCallBlock } from "../ToolCallBlock/ToolCallBlock";
import { WorkingIndicator } from "../WorkingIndicator/WorkingIndicator";
import styles from "./TurnGroup.module.css";

/** Props of {@link TurnGroup}. */
export type TurnGroupProps = {
    /** Complete turn entry projected by the transcript builder. */
    turn: TranscriptTurnItem;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when the user toggles the turn group. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Forwarded to Markdown links inside intermediate and final replies. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

function formatHeaderLabel(streaming: boolean, durationMs: number | null): string {
    if (streaming) {
        // The first sample of a running turn arrives on the next frame; until then the header names
        // the state without a misleading zero.
        return durationMs === null ? "Working" : `Working for ${formatTurnDuration(durationMs)}`;
    }

    return durationMs !== null ? `Worked for ${formatTurnDuration(durationMs)}` : "Worked";
}

function renderStep(
    step: TranscriptStep,
    onOpenLink: ((href: string) => void) | undefined,
    standalone: boolean,
): ReactElement | null {
    switch (step.kind) {
        case "thinking":
            return <ThinkingBlock step={step} {...(onOpenLink !== undefined ? { onOpenLink } : {})} />;
        case "toolCall":
            return <ToolCallBlock step={step} />;
        case "reply":
            if (standalone) {
                if (step.text.trim().length === 0) {
                    return null;
                }
                return (
                    <div className={styles.finalReply}>
                        <Markdown
                            streaming={step.streaming}
                            className={styles.markdown}
                            {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                        >
                            {step.text}
                        </Markdown>
                    </div>
                );
            }

            return (
                <div className={styles.replyStep} data-slot="transcript-reply-step">
                    <div className={styles.replyTrack} aria-hidden="true">
                        <Icon size="no-container" className={styles.icon}>
                            <MessageSquareText strokeWidth={1.75} />
                        </Icon>
                        <div className={styles.rail} />
                    </div>
                    <div className={styles.replyBody}>
                        <Markdown
                            streaming={step.streaming}
                            className={styles.markdown}
                            {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                        >
                            {step.text}
                        </Markdown>
                    </div>
                </div>
            );
        default:
            return assertNever(step);
    }
}

/**
 * Primary turn container grouping reasoning blocks, tool invocations and intermediate replies
 * behind a `Worked for Xs` disclosure.
 *
 * A single step renders directly without the group wrapper, so a short answer stays a short
 * answer. The final reply always sits outside the disclosure because it is the result the reader
 * came for.
 *
 * @param props - Turn item and optional expansion control.
 */
export function TurnGroup({
    turn,
    defaultOpen = false,
    open: controlledOpen,
    onOpenChange,
    onOpenLink,
    className,
}: TurnGroupProps): ReactElement {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const panelId = useId();
    const open = controlledOpen ?? uncontrolledOpen;
    const liveDurationMs = useLiveDuration(turn.timing, 1000);

    const handleToggle = () => {
        const next = !open;
        if (controlledOpen === undefined) {
            setUncontrolledOpen(next);
        }
        onOpenChange?.(next);
    };

    const headerLabel = formatHeaderLabel(turn.streaming, liveDurationMs);
    const singleStep = turn.steps.length === 1 ? turn.steps[0] : undefined;
    const hasGroup = turn.steps.length > 1;
    const hasFinalReply = turn.finalReply !== null && turn.finalReply.trim().length > 0;

    return (
        <div className={cn(styles.root, className)}>
            {singleStep !== undefined ? renderStep(singleStep, onOpenLink, true) : null}

            {hasGroup ? (
                <div className={styles.group}>
                    <button
                        type="button"
                        className={styles.trigger}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={handleToggle}
                    >
                        <Icon size="no-container" className={styles.icon}>
                            <Layers strokeWidth={1.75} />
                        </Icon>
                        <span className={styles.label}>{headerLabel}</span>
                        <Icon size="no-container" className={styles.chevron} data-open={open ? "true" : undefined}>
                            <ChevronRight strokeWidth={1.75} />
                        </Icon>
                    </button>

                    <div id={panelId} className={styles.collapse} data-open={open ? "true" : undefined}>
                        <div className={styles.collapseInner} inert={!open} aria-hidden={!open}>
                            <div className={styles.timeline}>
                                {turn.steps.map((step) => (
                                    <Fragment key={step.id}>
                                        <div
                                            className={styles.connector}
                                            aria-hidden="true"
                                            data-slot="transcript-connector"
                                        >
                                            <div className={styles.connectorLine} />
                                        </div>
                                        {renderStep(step, onOpenLink, false)}
                                    </Fragment>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {hasFinalReply && turn.finalReply !== null ? (
                <div className={styles.finalReply}>
                    <Markdown
                        streaming={turn.streaming}
                        className={styles.markdown}
                        {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                    >
                        {turn.finalReply}
                    </Markdown>
                </div>
            ) : null}

            {turn.errorMessage !== null ? (
                <div className={styles.error} role="alert">
                    {turn.errorMessage}
                </div>
            ) : null}

            {turn.streaming ? <WorkingIndicator /> : null}
        </div>
    );
}
