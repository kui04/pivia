import type { SessionModelInfo } from "@pivia/protocol";
import { Bot, Check, Search } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { Icon, ScrollArea } from "@components";
import { isImeComposition } from "@/lib";

import type { ComposerCommandSender, PickerCatalogState } from "../../types";
import {
    PickerOptionLabel,
    PickerPopover,
    PickerSkeleton,
    PickerStatus,
    useListboxNavigation,
    usePickerCatalog,
} from "../PickerMenu";
import pickerStyles from "../PickerMenu/PickerMenu.module.css";
import { createProviderLogoCache, type ProviderLogoCache, type ProviderLogoState } from "./logos";
import {
    createModelCatalogCache,
    filterModels,
    modelChoiceKey,
    orderModelsByProvider,
    parseAvailableModelsData,
    type ModelCatalogCache,
} from "./models";
import styles from "./ModelPicker.module.css";

export interface ModelPickerProps {
    /** Scope key (typically session id) used for caching `get_available_models`. */
    readonly cacheKey?: string | undefined;
    /** Active model reported by `SessionStateSnapshot`. */
    readonly current: SessionModelInfo | null;
    /** Disables opening or selecting when the session runtime is unavailable. */
    readonly disabled?: boolean | undefined;
    /** Controlled popover open state owned by `Composer` so pickers stay mutually exclusive. */
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    /** Optional injected model catalog cache (defaults to shared module cache). */
    readonly catalogCache?: ModelCatalogCache | undefined;
    /** Optional injected provider logo cache (defaults to shared module cache). */
    readonly logoCache?: ProviderLogoCache | undefined;
    /** RPC dispatcher used to load available models and apply the selected model. */
    readonly onSendCommand: ComposerCommandSender;
    /** Surface RPC errors to the caller's notification channel. */
    readonly onError: (message: string) => void;
}

const defaultCatalogCache = createModelCatalogCache();
const defaultLogoCache = createProviderLogoCache();
const SKELETON_ROWS = ["70%", "55%", "80%", "60%", "75%"] as const;

function useProviderLogo(provider: string | null, logoCache: ProviderLogoCache): ProviderLogoState {
    const cached = useMemo(() => (provider === null ? null : logoCache.getCached(provider)), [logoCache, provider]);
    const [loaded, setLoaded] = useState<{ readonly provider: string; readonly logo: ProviderLogoState } | null>(null);

    useEffect(() => {
        if (provider === null || cached !== null) {
            return;
        }
        let cancelled = false;
        void logoCache.load(provider).then((resolved) => {
            if (!cancelled) {
                setLoaded({ provider, logo: resolved });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [cached, logoCache, provider]);

    if (cached !== null) {
        return cached;
    }
    if (loaded !== null && loaded.provider === provider) {
        return loaded.logo;
    }
    return { kind: "missing" };
}

function useProviderLogos(
    models: readonly SessionModelInfo[],
    logoCache: ProviderLogoCache,
): ReadonlyMap<string, ProviderLogoState> {
    const providers = useMemo(() => [...new Set(models.map((model) => model.provider))], [models]);
    const { cachedMap, pending } = useMemo(() => {
        const nextMap = new Map<string, ProviderLogoState>();
        const nextPending: string[] = [];
        for (const provider of providers) {
            const cached = logoCache.getCached(provider);
            if (cached !== null) {
                nextMap.set(provider, cached);
            } else {
                nextPending.push(provider);
            }
        }
        return { cachedMap: nextMap, pending: nextPending };
    }, [logoCache, providers]);

    const [loadedMap, setLoadedMap] = useState<ReadonlyMap<string, ProviderLogoState>>(() => new Map());

    useEffect(() => {
        if (pending.length === 0) {
            return;
        }
        let cancelled = false;
        void Promise.all(pending.map(async (provider) => [provider, await logoCache.load(provider)] as const)).then(
            (resolved) => {
                if (cancelled) {
                    return;
                }
                setLoadedMap((prev) => {
                    const next = new Map(prev);
                    for (const [provider, state] of resolved) {
                        next.set(provider, state);
                    }
                    return next;
                });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [logoCache, pending]);

    return useMemo(() => {
        if (loadedMap.size === 0) {
            return cachedMap;
        }
        const merged = new Map(cachedMap);
        for (const [provider, state] of loadedMap) {
            if (!merged.has(provider)) {
                merged.set(provider, state);
            }
        }
        return merged;
    }, [cachedMap, loadedMap]);
}

function ProviderMark({
    provider,
    logo,
}: {
    readonly provider: string | null;
    readonly logo: ProviderLogoState;
}): ReactElement {
    return (
        <Icon size="no-container" className={styles.providerMark}>
            {logo.kind === "svg" ? (
                <span
                    data-provider={provider ?? undefined}
                    className={styles.providerMask}
                    style={{
                        maskImage: `url("${logo.maskDataUrl}")`,
                        WebkitMaskImage: `url("${logo.maskDataUrl}")`,
                    }}
                />
            ) : (
                <Bot />
            )}
        </Icon>
    );
}

interface ModelRowProps {
    readonly id: string;
    readonly model: SessionModelInfo;
    readonly logo: ProviderLogoState;
    readonly index: number;
    readonly inUse: boolean;
    readonly lit: boolean;
    readonly onPoint: (index: number) => void;
    readonly onChoose: (model: SessionModelInfo) => void;
}

const ModelRow = memo(function ModelRow({
    id,
    model,
    logo,
    index,
    inUse,
    lit,
    onPoint,
    onChoose,
}: ModelRowProps): ReactElement {
    return (
        // Focus stays on the combobox input, which moves the highlight with the arrow keys.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events
        <div
            id={id}
            role="option"
            aria-selected={lit}
            tabIndex={-1}
            data-lit={lit}
            className={pickerStyles.option}
            onClick={() => {
                onChoose(model);
            }}
            onMouseMove={() => {
                onPoint(index);
            }}
        >
            <ProviderMark provider={model.provider} logo={logo} />
            <PickerOptionLabel title={`${model.provider}/${model.id}`}>{model.name}</PickerOptionLabel>
            {inUse ? (
                <Icon size="no-container" className={pickerStyles.checkIcon}>
                    <Check />
                </Icon>
            ) : null}
        </div>
    );
});

interface ModelMenuProps {
    readonly catalog: PickerCatalogState<SessionModelInfo>;
    readonly activeKey: string | null;
    readonly logoCache: ProviderLogoCache;
    readonly onRetry: () => void;
    readonly onChoose: (model: SessionModelInfo) => void;
}

function ModelMenu({ catalog, activeKey, logoCache, onRetry, onChoose }: ModelMenuProps): ReactElement {
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listId = `${useId()}-models`;

    const items = useMemo(() => (catalog.kind === "ready" ? catalog.items : []), [catalog]);
    const logos = useProviderLogos(items, logoCache);

    const shown = useMemo(() => {
        const trimmed = query.trim();
        return trimmed.length === 0 ? orderModelsByProvider(items, activeKey) : filterModels(items, trimmed);
    }, [activeKey, items, query]);

    const { litIndex, setHovered, move, resetCursor } = useListboxNavigation({
        itemCount: shown.length,
        listId,
        scrollKey: query,
    });

    useEffect(() => {
        searchRef.current?.focus({ preventScroll: true });
    }, []);

    if (catalog.kind === "error") {
        return (
            <div className={styles.menu}>
                <PickerStatus message={catalog.message} onRetry={onRetry} />
            </div>
        );
    }

    return (
        <div className={styles.menu}>
            <div className={styles.searchRow}>
                <Icon size="no-container">
                    <Search />
                </Icon>
                <input
                    ref={searchRef}
                    type="search"
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={litIndex < 0 ? undefined : `${listId}-${litIndex}`}
                    aria-autocomplete="list"
                    aria-label="Search models"
                    placeholder="Search models"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    value={query}
                    className={styles.searchInput}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setHovered(null);
                        resetCursor();
                    }}
                    onKeyDown={(event) => {
                        const composing = isImeComposition(event.nativeEvent);
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            move(1);
                        } else if (event.key === "ArrowUp") {
                            event.preventDefault();
                            move(-1);
                        } else if (event.key === "Enter" && !composing) {
                            const picked =
                                litIndex < 0
                                    ? activeKey === null
                                        ? shown[0]
                                        : items.find((model) => modelChoiceKey(model) === activeKey)
                                    : shown[litIndex];
                            if (picked !== undefined) {
                                event.preventDefault();
                                onChoose(picked);
                            }
                        }
                    }}
                />
            </div>
            <ScrollArea
                label="Models"
                className={pickerStyles.scroll}
                viewportClassName={pickerStyles.viewport}
                contentClassName={pickerStyles.content}
                viewportTabIndex={-1}
            >
                {catalog.kind === "loading" ? (
                    <PickerSkeleton label="Loading models" widths={SKELETON_ROWS} />
                ) : (
                    <div
                        id={listId}
                        role="listbox"
                        aria-label="Models"
                        tabIndex={-1}
                        className={pickerStyles.listbox}
                        onMouseLeave={() => {
                            setHovered(null);
                        }}
                    >
                        {shown.length === 0 ? (
                            <PickerStatus message="No matching models." />
                        ) : (
                            shown.map((model, index) => {
                                const key = modelChoiceKey(model);
                                return (
                                    <ModelRow
                                        key={key}
                                        id={`${listId}-${index}`}
                                        model={model}
                                        logo={logos.get(model.provider) ?? { kind: "missing" }}
                                        index={index}
                                        inUse={key === activeKey}
                                        lit={index === litIndex}
                                        onPoint={setHovered}
                                        onChoose={onChoose}
                                    />
                                );
                            })
                        )}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}

function ModelCatalogBody({
    cacheKey,
    activeKey,
    catalogCache,
    logoCache,
    onSendCommand,
    onChoose,
}: {
    readonly cacheKey: string;
    readonly activeKey: string | null;
    readonly catalogCache: ModelCatalogCache;
    readonly logoCache: ProviderLogoCache;
    readonly onSendCommand: ComposerCommandSender;
    readonly onChoose: (model: SessionModelInfo) => void;
}): ReactElement {
    const { catalog, retry } = usePickerCatalog<SessionModelInfo>({
        cacheKey,
        command: "get_available_models",
        parse: parseAvailableModelsData,
        invalidDataMessage: "Received an invalid model catalog.",
        cache: catalogCache,
        onSendCommand,
    });

    return (
        <ModelMenu catalog={catalog} activeKey={activeKey} logoCache={logoCache} onRetry={retry} onChoose={onChoose} />
    );
}

/**
 * Footer pill and searchable upward popover for switching the active session model.
 */
export function ModelPicker({
    cacheKey = "default",
    current,
    disabled = false,
    open,
    onOpenChange,
    catalogCache = defaultCatalogCache,
    logoCache = defaultLogoCache,
    onSendCommand,
    onError,
}: ModelPickerProps): ReactElement {
    const activeLogo = useProviderLogo(current?.provider ?? null, logoCache);
    const activeKey = current === null ? null : modelChoiceKey(current);

    const handleChoose = useCallback(
        (model: SessionModelInfo) => {
            onOpenChange(false);
            if (modelChoiceKey(model) === activeKey) {
                return;
            }
            void onSendCommand({
                type: "set_model",
                provider: model.provider,
                modelId: model.id,
            })
                .then((response) => {
                    if (!response.success) {
                        onError(response.error);
                    }
                })
                .catch((cause: unknown) => {
                    onError(cause instanceof Error ? cause.message : String(cause));
                });
        },
        [activeKey, onError, onOpenChange, onSendCommand],
    );

    const modelLabel = current?.name ?? "Model";

    return (
        <PickerPopover
            open={open}
            onOpenChange={onOpenChange}
            disabled={disabled}
            label={`Model: ${modelLabel}`}
            title={current === null ? "Model" : `${current.provider}/${current.id}`}
            dialogLabel="Model picker"
            pillClassName={styles.trigger}
            popupClassName={styles.popup}
            triggerChildren={
                <>
                    <ProviderMark provider={current?.provider ?? null} logo={activeLogo} />
                    <span className={pickerStyles.triggerLabel}>{modelLabel}</span>
                </>
            }
        >
            <ModelCatalogBody
                key={cacheKey}
                cacheKey={cacheKey}
                activeKey={activeKey}
                catalogCache={catalogCache}
                logoCache={logoCache}
                onSendCommand={onSendCommand}
                onChoose={handleChoose}
            />
        </PickerPopover>
    );
}
