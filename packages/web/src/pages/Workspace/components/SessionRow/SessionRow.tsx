import type { SessionId } from "@pivia/protocol";
import { Copy, EllipsisVertical, Pin, PinOff, X } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent, type ReactElement } from "react";

import { IconButton, Menu, MenuItem } from "@components";
import { useMediaQuery } from "@/hooks";
import { Formatter } from "@/lib";
import { sessionRowStatus, type SessionRow as SessionRowModel } from "@/stores/workspace";

import styles from "./SessionRow.module.css";

/** How long a touch must rest before the session menu opens. */
const LONG_PRESS_MS = 500;

/** How far a touching finger may drift before the press counts as a scroll instead of a hold. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export interface SessionRowProps {
    readonly session: SessionRowModel;
    readonly nowMs: number;
    readonly closing: boolean;
    readonly onSelect: (id: SessionId) => void;
    readonly onTogglePinned: (id: SessionId) => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
}

function areSessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
    if (
        prev.nowMs !== next.nowMs ||
        prev.closing !== next.closing ||
        prev.onSelect !== next.onSelect ||
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
 * the runtime is starting, streaming, compacting, closing or attached.
 */
function SessionRowInner({
    session,
    nowMs,
    closing,
    onSelect,
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
                <span className={styles.age} data-state={status.kind === "active" ? status.state : undefined}>
                    {status.kind === "idle" ? (
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
                    <MenuItem
                        icon={<Copy />}
                        onClick={() => {
                            onCopySessionId(session.id);
                        }}
                    >
                        Copy session ID
                    </MenuItem>
                    <MenuItem
                        icon={<X />}
                        disabled={closeDisabled}
                        onClick={() => {
                            onCloseSession(session.id);
                        }}
                    >
                        Close session
                    </MenuItem>
                </Menu>
            </span>
        </li>
    );
}

/** Memoized session row to avoid re-rendering unchanged rows on single-session updates. */
export const SessionRow = memo(SessionRowInner, areSessionRowPropsEqual);
