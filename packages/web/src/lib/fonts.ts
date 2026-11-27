/** Font roles owned by the design system (`--font-sans`, `--font-serif`, `--font-mono`). */
export type FontRole = "sans" | "serif" | "mono";

/** Registered font preset identifiers available per role for lazy loading and future switching. */
export type FontPresetId = "google-sans" | "newsreader" | "jetbrains-mono" | "system";

export interface FontPreset {
    readonly id: FontPresetId;
    readonly role: FontRole | "all";
    readonly label: string;
    readonly stack: string | null;
    readonly load: (() => Promise<unknown>) | null;
}

const SYSTEM_STACKS: Record<FontRole, string> = {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: 'ui-serif, Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

/** Catalog of font presets, keyed by preset id. */
export const FONT_PRESETS: Record<FontPresetId, FontPreset> = {
    "google-sans": {
        id: "google-sans",
        role: "sans",
        label: "Google Sans",
        stack: `"Google Sans Variable", ${SYSTEM_STACKS.sans}`,
        load: () => import("@/styles/fonts/google-sans.css"),
    },
    newsreader: {
        id: "newsreader",
        role: "serif",
        label: "Newsreader",
        stack: `"Newsreader Variable", ${SYSTEM_STACKS.serif}`,
        load: () => import("@/styles/fonts/newsreader.css"),
    },
    "jetbrains-mono": {
        id: "jetbrains-mono",
        role: "mono",
        label: "JetBrains Mono",
        stack: `"JetBrains Mono Variable", ${SYSTEM_STACKS.mono}`,
        load: () => import("@/styles/fonts/jetbrains-mono.css"),
    },
    system: {
        id: "system",
        role: "all",
        label: "System default",
        stack: null,
        load: null,
    },
};

const DEFAULT_ROLE_PRESETS: Record<FontRole, FontPresetId> = {
    sans: "google-sans",
    serif: "newsreader",
    mono: "jetbrains-mono",
};

export interface FontManagerOptions {
    readonly presets?: Record<FontPresetId, FontPreset> | undefined;
    readonly defaultRolePresets?: Record<FontRole, FontPresetId> | undefined;
    readonly applyCssStack?: ((role: FontRole, stack: string) => void) | undefined;
}

export interface FontManager {
    ensureFontPreset: (presetId: FontPresetId) => Promise<void>;
    ensureFontRole: (role: FontRole) => Promise<void>;
    applyFontPreset: (role: FontRole, presetId: FontPresetId) => Promise<void>;
    getActivePreset: (role: FontRole) => FontPresetId;
}

function defaultApplyCssStack(role: FontRole, stack: string): void {
    if (typeof document === "undefined") {
        return;
    }
    document.documentElement.style.setProperty(`--font-${role}`, stack);
}

/**
 * Creates a deduplicated lazy font loader and role-to-preset registry.
 *
 * Each preset's CSS chunk is dynamically imported at most once while active or resolved;
 * failed loads clear the cached promise so a subsequent mount or retry can recover.
 */
export function createFontManager(options: FontManagerOptions = {}): FontManager {
    const presets = options.presets ?? FONT_PRESETS;
    const activeByRole: Record<FontRole, FontPresetId> = {
        ...(options.defaultRolePresets ?? DEFAULT_ROLE_PRESETS),
    };
    const applyCssStack = options.applyCssStack ?? defaultApplyCssStack;
    const inflight = new Map<FontPresetId, Promise<void>>();

    const ensureFontPreset = async (presetId: FontPresetId): Promise<void> => {
        const preset = presets[presetId];
        if (preset.load === null) {
            return;
        }
        const existing = inflight.get(presetId);
        if (existing !== undefined) {
            return existing;
        }

        const pending = Promise.resolve(preset.load())
            .then(() => undefined)
            .catch((error: unknown) => {
                // Allow a later attempt to retry if a transient network failure occurred.
                inflight.delete(presetId);
                throw error;
            });
        inflight.set(presetId, pending);
        return pending;
    };

    const ensureFontRole = async (role: FontRole): Promise<void> => {
        if (typeof window === "undefined") {
            return;
        }
        await ensureFontPreset(activeByRole[role]).catch(() => undefined);
    };

    const applyFontPreset = async (role: FontRole, presetId: FontPresetId): Promise<void> => {
        const preset = presets[presetId];
        if (preset.role !== "all" && preset.role !== role) {
            throw new Error(`Font preset "${presetId}" belongs to role "${preset.role}", not "${role}"`);
        }
        activeByRole[role] = presetId;
        const stack = preset.stack ?? SYSTEM_STACKS[role];
        applyCssStack(role, stack);
        await ensureFontPreset(presetId);
    };

    const getActivePreset = (role: FontRole): FontPresetId => activeByRole[role];

    return {
        ensureFontPreset,
        ensureFontRole,
        applyFontPreset,
        getActivePreset,
    };
}

const defaultManager = createFontManager();

/** Ensures the active web font for `role` is loaded in the browser without blocking render. */
export function ensureFontRole(role: FontRole): Promise<void> {
    return defaultManager.ensureFontRole(role);
}

/** Switches the active font preset for `role`, updating `--font-<role>` and loading its face if needed. */
export function applyFontPreset(role: FontRole, presetId: FontPresetId): Promise<void> {
    return defaultManager.applyFontPreset(role, presetId);
}

/** Returns the active preset id for `role`. */
export function getActiveFontPreset(role: FontRole): FontPresetId {
    return defaultManager.getActivePreset(role);
}

/**
 * Schedules the default UI sans face during browser idle time so initial paint renders
 * immediately with system fonts and zero font-network contention.
 */
export function scheduleDefaultFonts(): () => void {
    if (typeof window === "undefined") {
        return () => {};
    }

    const loadSans = (): void => {
        void ensureFontRole("sans");
    };

    if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(loadSans, { timeout: 1500 });
        return () => {
            window.cancelIdleCallback(handle);
        };
    }

    const timer = window.setTimeout(loadSans, 150);
    return () => {
        window.clearTimeout(timer);
    };
}
