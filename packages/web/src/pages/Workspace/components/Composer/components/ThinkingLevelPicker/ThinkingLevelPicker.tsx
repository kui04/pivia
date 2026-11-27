import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Brain, Check } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type ReactElement } from "react";

import { Icon, ScrollArea } from "@components";

import type { ComposerCommandSender } from "../../types";
import {
    PickerOptionLabel,
    PickerPopover,
    PickerSkeleton,
    PickerStatus,
    useListboxNavigation,
    usePickerCatalog,
} from "../PickerMenu";
import pickerStyles from "../PickerMenu/PickerMenu.module.css";
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
    const { litIndex, setHovered, move } = useListboxNavigation({ itemCount: levels.length, listId });

    useEffect(() => {
        listRef.current?.focus({ preventScroll: true });
    }, []);

    return (
        <ScrollArea
            label="Thinking levels"
            className={pickerStyles.scroll}
            viewportClassName={pickerStyles.viewport}
            contentClassName={pickerStyles.content}
            viewportTabIndex={-1}
        >
            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Choose thinking level"
                aria-activedescendant={litIndex < 0 ? undefined : `${listId}-${litIndex}`}
                tabIndex={0}
                className={pickerStyles.listbox}
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
                    // Focus stays on the listbox container, which drives the highlight with the arrow keys.
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                    <div
                        key={level}
                        id={`${listId}-${index}`}
                        role="option"
                        aria-selected={index === litIndex}
                        tabIndex={-1}
                        data-lit={index === litIndex}
                        className={pickerStyles.option}
                        onClick={() => {
                            onChoose(level);
                        }}
                        onMouseMove={() => {
                            setHovered(index);
                        }}
                    >
                        <PickerOptionLabel>{level}</PickerOptionLabel>
                        {level === current ? (
                            <Icon size="no-container" className={pickerStyles.checkIcon}>
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
    cacheKey,
    current,
    onSendCommand,
    onChoose,
}: {
    readonly cacheKey: string;
    readonly current: ThinkingLevel | null;
    readonly onSendCommand: ComposerCommandSender;
    readonly onChoose: (level: ThinkingLevel) => void;
}): ReactElement {
    const { catalog, retry } = usePickerCatalog<ThinkingLevel>({
        cacheKey,
        command: "get_available_thinking_levels",
        parse: parseAvailableThinkingLevelsData,
        invalidDataMessage: "Could not read thinking levels.",
        onSendCommand,
    });

    if (catalog.kind === "loading") {
        return <PickerSkeleton label="Loading thinking levels" widths={SKELETON_ROWS} />;
    }

    if (catalog.kind === "error") {
        return <PickerStatus message={catalog.message} onRetry={retry} />;
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
        <PickerPopover
            open={open}
            onOpenChange={onOpenChange}
            disabled={disabled}
            label={`Thinking level: ${thinkingLabel}`}
            pillClassName={styles.trigger}
            popupClassName={styles.popup}
            triggerChildren={
                <>
                    <Icon size="no-container">
                        <Brain />
                    </Icon>
                    <span className={pickerStyles.triggerLabel}>{thinkingLabel}</span>
                </>
            }
        >
            <ThinkingLevelBody
                key={cacheKey}
                cacheKey={cacheKey}
                current={current}
                onSendCommand={onSendCommand}
                onChoose={handleChoose}
            />
        </PickerPopover>
    );
}
