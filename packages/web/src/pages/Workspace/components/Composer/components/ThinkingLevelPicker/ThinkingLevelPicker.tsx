import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Brain, Check } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import { Button, Icon, Popover, PopoverContent, PopoverTrigger, ScrollArea } from "@components";

import type { ComposerCommandSender, PickerCatalogState } from "../../types";
import { PickerPill } from "../PickerPill";
import { parseAvailableThinkingLevelsData } from "./thinking";
import styles from "./ThinkingLevelPicker.module.css";

export interface ThinkingLevelPickerProps {
    /** Session scope key so switching sessions resets the in-popover level list. */
    readonly cacheKey?: string | undefined;
    /** Active thinking level reported by `SessionStateSnapshot`. */
    readonly current: ThinkingLevel | null;
    /** Disables opening or selecting when the session runtime is unavailable. */
    readonly disabled?: boolean | undefined;
    /** Controlled popover open state owned by `Composer` so pickers stay mutually exclusive. */
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** RPC dispatcher used to load available levels and apply the selected level. */
    readonly onSendCommand: ComposerCommandSender;
    /** Surface RPC errors to the caller's notification channel. */
    readonly onError: (message: string) => void;
}

const SKELETON_ROWS = ["45%", "35%", "65%", "55%"] as const;

function LevelList({
    levels,
    current,
    onChoose,
}: {
    readonly levels: readonly ThinkingLevel[];
    readonly current: ThinkingLevel | null;
    readonly onChoose: (level: ThinkingLevel) => void;
}): ReactElement {
    const listId = `${useId()}-levels`;
    const listRef = useRef<HTMLDivElement | null>(null);
    const [cursor, setCursor] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);

    const cursorIndex = cursor ?? -1;
    const litIndex = levels.length === 0 ? -1 : Math.min(hovered ?? cursorIndex, levels.length - 1);

    useEffect(() => {
        listRef.current?.focus({ preventScroll: true });
    }, []);

    useLayoutEffect(() => {
        if (litIndex < 0) {
            return;
        }
        document.getElementById(`${listId}-${litIndex}`)?.scrollIntoView({ block: "nearest" });
    }, [listId, litIndex]);

    const move = (step: number): void => {
        if (levels.length === 0) {
            return;
        }
        setHovered(null);
        setCursor((prev) => {
            if (prev === null) {
                return step > 0 ? 0 : levels.length - 1;
            }
            return (prev + step + levels.length) % levels.length;
        });
    };

    return (
        <ScrollArea
            label="Thinking levels"
            className={styles.scroll}
            viewportClassName={styles.viewport}
            contentClassName={styles.content}
            viewportTabIndex={-1}
        >
            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Choose thinking level"
                aria-activedescendant={litIndex < 0 ? undefined : `${listId}-${litIndex}`}
                tabIndex={0}
                className={styles.listbox}
                onMouseLeave={() => {
                    setHovered(null);
                }}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        move(1);
                    } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        move(-1);
                    } else if (event.key === "Enter") {
                        const picked = litIndex < 0 ? current : levels[litIndex];
                        if (picked !== null && picked !== undefined) {
                            event.preventDefault();
                            onChoose(picked);
                        }
                    }
                }}
            >
                {levels.map((level, index) => (
                    // Focus stays on the combobox input, which moves the highlight with the arrow keys.
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <div
                        key={level}
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={index === litIndex}
                        tabIndex={-1}
                        data-lit={index === litIndex}
                        className={styles.option}
                        onClick={() => {
                            onChoose(level);
                        }}
                        onMouseMove={() => {
                            setHovered(index);
                        }}
                    >
                        <span className={styles.optionLabel}>{level}</span>
                        {level === current ? (
                            <Icon size="no-container" className={styles.checkIcon}>
                                <Check />
                            </Icon>
                        ) : null}
                    </div>
                ))}
            </div>
        </ScrollArea>
    );
}

function ThinkingLevelBody({
    current,
    onSendCommand,
    onChoose,
}: {
    readonly current: ThinkingLevel | null;
    readonly onSendCommand: ComposerCommandSender;
    readonly onChoose: (level: ThinkingLevel) => void;
}): ReactElement {
    const [catalog, setCatalog] = useState<PickerCatalogState<ThinkingLevel>>({ kind: "loading" });

    const fetchLevels = useCallback(
        (cancelledRef?: { current: boolean }): void => {
            void onSendCommand({ type: "get_available_thinking_levels" })
                .then((response) => {
                    if (cancelledRef?.current) {
                        return;
                    }
                    if (!response.success) {
                        setCatalog({ kind: "error", message: response.error });
                        return;
                    }
                    const levels = parseAvailableThinkingLevelsData(response.data);
                    if (levels === null) {
                        setCatalog({ kind: "error", message: "Could not read thinking levels." });
                        return;
                    }
                    setCatalog({ kind: "ready", items: levels });
                })
                .catch((cause: unknown) => {
                    if (cancelledRef?.current) {
                        return;
                    }
                    setCatalog({
                        kind: "error",
                        message: cause instanceof Error ? cause.message : String(cause),
                    });
                });
        },
        [onSendCommand],
    );

    useEffect(() => {
        const cancelledRef = { current: false };
        fetchLevels(cancelledRef);
        return () => {
            cancelledRef.current = true;
        };
    }, [fetchLevels]);

    if (catalog.kind === "loading" || catalog.kind === "idle") {
        return (
            <div role="status" aria-label="Loading thinking levels" className={styles.skeleton}>
                {SKELETON_ROWS.map((width, index) => (
                    <div key={index} aria-hidden="true" className={styles.skeletonRow} style={{ width }} />
                ))}
            </div>
        );
    }

    if (catalog.kind === "error") {
        return (
            <div className={styles.statusBox} role="alert">
                <p className={styles.statusText}>{catalog.message}</p>
                <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={() => {
                        setCatalog({ kind: "loading" });
                        fetchLevels();
                    }}
                >
                    Retry
                </Button>
            </div>
        );
    }

    return <LevelList levels={catalog.items} current={current} onChoose={onChoose} />;
}

/**
 * Footer pill and upward popover for switching the session thinking level.
 */
export function ThinkingLevelPicker({
    cacheKey = "default",
    current,
    disabled = false,
    open,
    onOpenChange,
    onSendCommand,
    onError,
}: ThinkingLevelPickerProps): ReactElement {
    const handleChoose = useCallback(
        (level: ThinkingLevel) => {
            onOpenChange(false);
            if (level === current) {
                return;
            }
            void onSendCommand({ type: "set_thinking_level", level })
                .then((response) => {
                    if (!response.success) {
                        onError(response.error);
                    }
                })
                .catch((cause: unknown) => {
                    onError(cause instanceof Error ? cause.message : String(cause));
                });
        },
        [current, onError, onOpenChange, onSendCommand],
    );

    const thinkingLabel = current ?? "Thinking";

    return (
        <Popover open={open && !disabled} onOpenChange={onOpenChange}>
            <PopoverTrigger
                render={
                    <PickerPill
                        aria-label={`Thinking level: ${thinkingLabel}`}
                        disabled={disabled}
                        className={styles.trigger}
                    />
                }
            >
                <Icon size="no-container">
                    <Brain />
                </Icon>
                <span className={styles.triggerLabel}>{thinkingLabel}</span>
            </PopoverTrigger>
            <PopoverContent
                side="top"
                align="start"
                sideOffset={10}
                collisionAvoidance={{ side: "none", align: "shift" }}
                className={styles.popup}
            >
                <ThinkingLevelBody
                    key={cacheKey}
                    current={current}
                    onSendCommand={onSendCommand}
                    onChoose={handleChoose}
                />
            </PopoverContent>
        </Popover>
    );
}
