import { describe, expect, it, vi } from "vitest";

import { createFontManager, FONT_PRESETS, type FontPreset, type FontPresetId } from "./fonts";

function createTestPresets(overrides: Partial<Record<FontPresetId, Partial<FontPreset>>> = {}) {
    return {
        "google-sans": {
            ...FONT_PRESETS["google-sans"],
            load: vi.fn(() => Promise.resolve()),
            ...overrides["google-sans"],
        },
        newsreader: {
            ...FONT_PRESETS.newsreader,
            load: vi.fn(() => Promise.resolve()),
            ...overrides.newsreader,
        },
        "jetbrains-mono": {
            ...FONT_PRESETS["jetbrains-mono"],
            load: vi.fn(() => Promise.resolve()),
            ...overrides["jetbrains-mono"],
        },
        system: { ...FONT_PRESETS.system, ...overrides.system },
    };
}

describe("createFontManager", () => {
    it("deduplicates repeated loads for the same preset", async () => {
        const presets = createTestPresets();
        const manager = createFontManager({ presets });

        await Promise.all([manager.ensureFontPreset("google-sans"), manager.ensureFontPreset("google-sans")]);
        await manager.ensureFontPreset("google-sans");

        expect(presets["google-sans"].load).toHaveBeenCalledTimes(1);
    });

    it("clears the cached promise after a load failure so retries can succeed", async () => {
        let attempt = 0;
        const load = vi.fn(() => {
            attempt += 1;
            if (attempt === 1) {
                return Promise.reject(new Error("network error"));
            }
            return Promise.resolve();
        });
        const presets = createTestPresets({ "jetbrains-mono": { load } });
        const manager = createFontManager({ presets });

        await expect(manager.ensureFontPreset("jetbrains-mono")).rejects.toThrow("network error");
        await expect(manager.ensureFontPreset("jetbrains-mono")).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("updates CSS stack for system fallback without fetching web fonts", async () => {
        const presets = createTestPresets();
        const applyCssStack = vi.fn();
        const manager = createFontManager({ presets, applyCssStack });

        await manager.applyFontPreset("mono", "system");

        expect(manager.getActivePreset("mono")).toBe("system");
        expect(applyCssStack).toHaveBeenCalledWith(
            "mono",
            'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
        );
        expect(presets["jetbrains-mono"].load).not.toHaveBeenCalled();
    });

    it("applies web font presets and rejects mismatched roles", async () => {
        const presets = createTestPresets();
        const applyCssStack = vi.fn();
        const manager = createFontManager({ presets, applyCssStack });

        await manager.applyFontPreset("serif", "newsreader");

        expect(manager.getActivePreset("serif")).toBe("newsreader");
        expect(applyCssStack).toHaveBeenCalledWith("serif", FONT_PRESETS.newsreader.stack);
        expect(presets.newsreader.load).toHaveBeenCalledTimes(1);

        await expect(manager.applyFontPreset("sans", "jetbrains-mono")).rejects.toThrow(
            'Font preset "jetbrains-mono" belongs to role "mono", not "sans"',
        );
    });

    it("tracks loaded font readiness and skips repeated promise creation after load", async () => {
        const presets = createTestPresets();
        const manager = createFontManager({ presets });

        expect(manager.isFontRoleReady("mono")).toBe(false);
        const firstPromise = manager.ensureFontPreset("jetbrains-mono");
        expect(manager.isFontRoleReady("mono")).toBe(false);

        await firstPromise;
        expect(manager.isFontRoleReady("mono")).toBe(true);
        expect(manager.ensureFontPreset("jetbrains-mono")).toBe(manager.ensureFontPreset("jetbrains-mono"));

        await manager.applyFontPreset("mono", "system");
        expect(manager.isFontRoleReady("mono")).toBe(true);
    });
});
