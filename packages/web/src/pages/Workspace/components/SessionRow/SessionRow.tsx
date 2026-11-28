import type { SessionId } from "@pivia/protocol";
import { EllipsisVertical, Pin, PinOff, SquareSplitHorizontal, SquareSplitVertical } from "lucide-react";
import { memo, useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactElement } from "react";

import { IconButton, Menu, MenuItem, MenuSeparator } from "@components";
import type { SplitAxis } from "@components/SplitPane/tree";
import { useMediaQuery } from "@/hooks";
import { Formatter } from "@/lib";
import { sessionRowStatus, type SessionRow as SessionRowModel } from "@/stores/workspace";

import { SessionCommonMenuItems } from "../SessionCommonMenuItems";

import styles from "./SessionRow.module.css";

/** How long a touch must rest before the session menu opens. */
const LONG_PRESS_MS = 500;

/** Accessible name of the trailing dot shown while an extension waits for an answer. */
const NEEDS_INPUT_LABEL = "Needs your answer";

/** How far a touching finger may drift before the press counts as a scroll instead of a hold. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export interface SessionRowProps {
    readonly session: SessionRowModel;
    readonly nowMs: number;
    readonly closing: boolean;
    /** True while the session runtime waits for an extension answer. */
    readonly needsInput?: boolean | undefined;
    readonly canSplitRow?: boolean | undefined;
    readonly canSplitColumn?: boolean | undefined;
    readonly onSelect: (id: SessionId) => void;
    readonly onSplitSession?: ((id: SessionId, axis: SplitAxis) => void) | undefined;
    readonly onDragStart?: ((id: SessionId, title: string, event: DragEvent<HTMLElement>) => void) | undefined;
    readonly onDragEnd?: (() => void) | undefined;
    readonly onTogglePinned: (id: SessionId) => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
}

function areSessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
    if (
        prev.nowMs !== next.nowMs ||
        prev.closing !== next.closing ||
        prev.needsInput !== next.needsInput ||
        prev.canSplitRow !== next.canSplitRow ||
        prev.canSplitColumn !== next.canSplitColumn ||
        prev.onSelect !== next.onSelect ||
        prev.onSplitSession !== next.onSplitSession ||
        prev.onDragStart !== next.onDragStart ||
        prev.onDragEnd !== next.onDragEnd ||
        prev.onTogglePinned !== next.onTogglePinned ||
        prev.onCopySessionId !== next.onCopySessionId ||
        prev.onCloseSession !== next.onCloseSession
    ) {
        return false;
    }
    const a = prev.session;
    const b = next.session;
    return (
        a.id === b.id &&
        a.title === b.title &&
        a.named === b.named &&
        a.cwd === b.cwd &&
        a.modifiedAtMs === b.modifiedAtMs &&
        a.runtimeState === b.runtimeState &&
        a.attachedClients === b.attachedClients &&
        a.pinned === b.pinned &&
        a.selected === b.selected
    );
}

/**
 * One session in the workspace sidebar.
 *
 * The row renders one primary button plus a sibling action layer (never nested buttons) so
 * keyboard focus reaches the title and actions separately. Touch devices open the same actions
 * via a long-press context menu. The trailing slot shows the relative age, or a status dot while
 * the runtime is starting, streaming, compacting, closing or attached. A pending extension answer
 * replaces either with a needs-input dot, because it blocks the runtime until the user replies.
 */
function SessionRowInner({
    session,
    nowMs,
    closing,
    needsInput = false,
    canSplitRow = true,
    canSplitColumn = true,
    onSelect,
    onSplitSession,
    onDragStart,
    onDragEnd,
    onTogglePinned,
    onCopySessionId,
    onCloseSession,
}: SessionRowProps): ReactElement {
    const [menuOpen, setMenuOpen] = useState(false);
    const hoverless = useMediaQuery("(hover: none)");
    const pressTimer = useRef<number | undefined>(undefined);
    const pressOrigin = useRef<{ x: number; y: number } | undefined>(undefined);
    const longPressed = useRef(false);

    const cancelPress = (): void => {
        window.clearTimeout(pressTimer.current);
        pressTimer.current = undefined;
        pressOrigin.current = undefined;
    };

    useEffect(
        () => () => {
            window.clearTimeout(pressTimer.current);
        },
        [],
    );

    const startPress = (event: PointerEvent<HTMLButtonElement>): void => {
        // A press whose click never arrived must not swallow the next click.
        longPressed.current = false;
        // Only touch has no hover to reveal the actions; mouse click selects the row.
        if (event.pointerType !== "touch") {
            return;
        }
        cancelPress();
        pressOrigin.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = window.setTimeout(() => {
            longPressed.current = true;
            setMenuOpen(true);
        }, LONG_PRESS_MS);
    };

    /** A hold that drifts is a scroll, so cancel once the finger leaves the tolerance. */
    const handlePressMove = (event: PointerEvent<HTMLButtonElement>): void => {
        const origin = pressOrigin.current;
        if (origin === undefined) {
            return;
        }
        const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
        if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) {
            cancelPress();
        }
    };

    const handleSelect = (): void => {
        // The click that ends a long press must not also select the row.
        if (longPressed.current) {
            longPressed.current = false;
            return;
        }
        onSelect(session.id);
    };

    const status = sessionRowStatus(session);
    const closeDisabled = closing || session.runtimeState === "closing";

    return (
        <li className={styles.item} data-selected={session.selected} data-open={menuOpen}>
            <button
                type="button"
                className={styles.select}
                aria-current={session.selected ? "true" : undefined}
                draggable={onDragStart !== undefined || undefined}
                onDragStart={
                    onDragStart === undefined
                        ? undefined
                        : (event) => {
                              onDragStart(session.id, session.title, event);
                          }
                }
                onDragEnd={onDragEnd}
                onClick={handleSelect}
                onPointerDown={startPress}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
                onPointerCancel={cancelPress}
                onPointerMove={handlePressMove}
                onContextMenu={(event) => {
                    // A long press already opened the menu; the platform one would replace it.
                    event.preventDefault();
                }}
            >
                <span className={styles.title} data-named={session.named} title={session.title}>
                    {session.title}
                </span>
                <span
                    className={styles.age}
                    data-state={needsInput ? "needs-input" : status.kind === "active" ? status.state : undefined}
                >
                    {needsInput ? (
                        <span
                            className={styles.indicator}
                            role="img"
                            aria-label={NEEDS_INPUT_LABEL}
                            title={NEEDS_INPUT_LABEL}
                        />
                    ) : status.kind === "idle" ? (
                        Formatter.relativeAge(status.modifiedAtMs, nowMs)
                    ) : (
                        <span className={styles.indicator} role="img" aria-label={status.label} title={status.label} />
                    )}
                </span>
            </button>
            <span className={styles.actions}>
                <IconButton
                    type="button"
                    label={session.pinned ? "Unpin session" : "Pin session"}
                    aria-pressed={session.pinned}
                    onClick={() => {
                        onTogglePinned(session.id);
                    }}
                >
                    {session.pinned ? <PinOff /> : <Pin />}
                </IconButton>
                <Menu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    align="end"
                    trigger={
                        <IconButton type="button" label="Session actions">
                            <EllipsisVertical />
                        </IconButton>
                    }
                >
                    {onSplitSession === undefined ? null : (
                        <>
                            <MenuItem
                                icon={<SquareSplitHorizontal />}
                                disabled={!canSplitRow}
                                onClick={() => {
                                    onSplitSession(session.id, "row");
                                }}
                            >
                                Split right
                            </MenuItem>
                            <MenuItem
                                icon={<SquareSplitVertical />}
                                disabled={!canSplitColumn}
                                onClick={() => {
                                    onSplitSession(session.id, "column");
                                }}
                            >
                                Split down
                            </MenuItem>
                            <MenuSeparator />
                        </>
                    )}
                    {hoverless ? (
                        <MenuItem
                            icon={session.pinned ? <PinOff /> : <Pin />}
                            onClick={() => {
                                onTogglePinned(session.id);
                            }}
                        >
                            {session.pinned ? "Unpin session" : "Pin session"}
                        </MenuItem>
                    ) : null}
                    <SessionCommonMenuItems
                        sessionId={session.id}
                        closeDisabled={closeDisabled}
                        onCopySessionId={onCopySessionId}
                        onCloseSession={onCloseSession}
                    />
                </Menu>
            </span>
        </li>
    );
}

/** Memoized session row to avoid re-rendering unchanged rows on single-session updates. */
export const SessionRow = memo(SessionRowInner, areSessionRowPropsEqual);
