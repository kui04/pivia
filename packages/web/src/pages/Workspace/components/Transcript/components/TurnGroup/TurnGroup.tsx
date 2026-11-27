import { assertNever } from "@pivia/protocol";
import { AlertTriangle, Ban, CircleAlert, Layers, MessageSquareText, type LucideIcon } from "lucide-react";
import { Fragment, type ReactElement } from "react";

import { Icon, Markdown } from "@components";
import { cn, Formatter } from "@/lib";
import { type TranscriptStep, type TranscriptTurnItem, type TranscriptTurnOutcome } from "@/stores/session";

import { WORKING_LABEL } from "../../useActivityLabel";
import { useLiveDuration } from "../../useLiveDuration";
import { Disclosure, useDisclosure } from "../Disclosure";
import { Notice } from "../Notice";
import { RailScrollArea } from "../RailScrollArea";
import { ThinkingBlock } from "../ThinkingBlock";
import { ToolCallBlock } from "../ToolCallBlock";
import { WorkingIndicator } from "../WorkingIndicator";
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
    /** Visible label for the trailing working indicator while streaming (`Compacting context...`, etc.). */
    activityLabel?: string | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

function formatHeaderLabel(streaming: boolean, durationMs: number | null): string {
    if (streaming) {
        // The first sample of a running turn arrives on the next frame; until then the header shows
        // the shared working label instead of a misleading zero.
        return durationMs === null ? WORKING_LABEL : `Working for ${Formatter.duration(durationMs)}`;
    }

    return durationMs !== null ? `Worked for ${Formatter.duration(durationMs)}` : "Worked";
}

type TurnFooterNotice = {
    readonly key: string;
    readonly text: string;
    readonly tone: "error" | "warning" | "muted";
    readonly icon: LucideIcon;
    readonly announce: boolean;
};

/** Notice descriptor for an abnormal ending, or null when the turn ended normally. */
function outcomeNotice(outcome: TranscriptTurnOutcome): TurnFooterNotice | null {
    switch (outcome.kind) {
        case "truncated":
            return {
                key: "truncated",
                text: "Response was truncated before completion.",
                tone: "warning",
                icon: AlertTriangle,
                announce: false,
            };
        case "aborted":
            return {
                key: "aborted",
                text: outcome.message,
                tone: "muted",
                icon: Ban,
                announce: true,
            };
        case "error":
            return {
                key: "error",
                text: outcome.message,
                tone: "error",
                icon: CircleAlert,
                announce: true,
            };
        case "open":
        case "completed":
            return null;
        // A deferred response is still being polled by the provider and the turn resumes when it
        // settles, so a notice here would flash and disappear.
        case "deferred":
            return null;
        default:
            return assertNever(outcome);
    }
}

function renderStep(
    step: TranscriptStep,
    onOpenLink: ((href: string) => void) | undefined,
    standalone: boolean,
): ReactElement | null {
    switch (step.kind) {
        case "thinking":
            return <ThinkingBlock step={step} onOpenLink={onOpenLink} />;
        case "toolCall":
            return <ToolCallBlock step={step} />;
        case "reply":
            if (standalone) {
                if (step.text.trim().length === 0) {
                    return null;
                }
                return (
                    <div className={styles.finalReply}>
                        <Markdown streaming={step.streaming} className={styles.markdown} onOpenLink={onOpenLink}>
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
                        <Markdown streaming={step.streaming} className={styles.markdown} onOpenLink={onOpenLink}>
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
    activityLabel,
    className,
}: TurnGroupProps): ReactElement {
    const { open, onOpenChange: handleOpenChange } = useDisclosure({
        defaultOpen,
        open: controlledOpen,
        onOpenChange,
    });
    const liveDurationMs = useLiveDuration(turn.timing, 1000);

    const headerLabel = formatHeaderLabel(turn.streaming, liveDurationMs);
    // A live message settles before the runtime reports `agent_settled`, so the notice waits:
    // otherwise a finished-looking error, truncation, or diagnostic warning would sit beside the working row.
    const footerNotices: TurnFooterNotice[] = [];
    if (!turn.streaming) {
        const outcomeRow = outcomeNotice(turn.outcome);
        if (outcomeRow !== null) {
            footerNotices.push(outcomeRow);
        }
        if (turn.diagnosticsNotice !== undefined) {
            footerNotices.push({
                key: "diagnostics",
                text: turn.diagnosticsNotice,
                tone: "warning",
                icon: AlertTriangle,
                announce: false,
            });
        }
    }
    const singleStep = turn.steps.length === 1 ? turn.steps[0] : undefined;
    const hasGroup = turn.steps.length > 1;
    const hasFinalReply = turn.finalReply !== null && turn.finalReply.trim().length > 0;

    return (
        <div className={cn(styles.root, className)}>
            {singleStep !== undefined ? renderStep(singleStep, onOpenLink, true) : null}

            {hasGroup ? (
                <Disclosure open={open} onOpenChange={handleOpenChange} icon={Layers} label={headerLabel}>
                    <RailScrollArea
                        label="Turn steps"
                        enabled={open}
                        streaming={turn.streaming}
                        maxHeight="lg"
                        indent="trigger"
                    >
                        <div className={styles.timeline}>
                            {turn.steps.map((step) => (
                                <Fragment key={step.id}>{renderStep(step, onOpenLink, false)}</Fragment>
                            ))}
                        </div>
                    </RailScrollArea>
                </Disclosure>
            ) : null}

            {hasFinalReply ? (
                <div className={styles.finalReply}>
                    <Markdown streaming={turn.streaming} className={styles.markdown} onOpenLink={onOpenLink}>
                        {turn.finalReply}
                    </Markdown>
                </div>
            ) : null}

            {footerNotices.map((notice) => (
                <Notice
                    key={notice.key}
                    tone={notice.tone === "error" ? "error" : "status"}
                    icon={notice.icon}
                    warningIcon={notice.tone === "warning"}
                    live={notice.announce ? "alert" : "status"}
                    className={styles.footerNotice}
                >
                    {notice.text}
                </Notice>
            ))}

            {turn.streaming ? <WorkingIndicator label={activityLabel ?? WORKING_LABEL} /> : null}
        </div>
    );
}
