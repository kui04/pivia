import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

class FakeHTMLElement {
    focus = vi.fn();
}

type FakeTextarea = {
    value: string;
    style: Record<string, string>;
    setAttribute: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    setSelectionRange: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
};

function installLegacyClipboard(options: { copied: boolean; activeElement?: unknown }) {
    const textarea: FakeTextarea = {
        value: "",
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        remove: vi.fn(),
    };
    const fakeDocument = {
        activeElement: options.activeElement ?? null,
        createElement: vi.fn(() => textarea),
        body: { append: vi.fn() },
        execCommand: vi.fn(() => options.copied),
    };
    vi.stubGlobal("document", fakeDocument);

    return { fakeDocument, textarea };
}

beforeEach(() => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("copyText", () => {
    it("writes through the async clipboard API when it is available", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });

        await copyText("hello");

        expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("uses the legacy copy path when the async API is missing", async () => {
        vi.stubGlobal("navigator", {});
        const { fakeDocument, textarea } = installLegacyClipboard({ copied: true });

        await copyText("hello");

        expect(fakeDocument.createElement).toHaveBeenCalledExactlyOnceWith("textarea");
        expect(fakeDocument.body.append).toHaveBeenCalledExactlyOnceWith(textarea);
        expect(textarea.value).toBe("hello");
        expect(textarea.setAttribute).toHaveBeenCalledExactlyOnceWith("readonly", "");
        expect(textarea.select).toHaveBeenCalledOnce();
        expect(textarea.setSelectionRange).toHaveBeenCalledExactlyOnceWith(0, 5);
        expect(fakeDocument.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
        expect(textarea.remove).toHaveBeenCalledOnce();
    });

    it("restores the previous focus after the legacy path", async () => {
        vi.stubGlobal("navigator", {});
        const previousFocus = new FakeHTMLElement();
        installLegacyClipboard({ copied: true, activeElement: previousFocus });

        await copyText("hello");

        expect(previousFocus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    });

    it("falls back when the async API rejects", async () => {
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const { fakeDocument } = installLegacyClipboard({ copied: true });

        await copyText("hello");

        expect(writeText).toHaveBeenCalledOnce();
        expect(fakeDocument.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    });

    it("rejects when both paths fail and still removes the temporary textarea", async () => {
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const { fakeDocument, textarea } = installLegacyClipboard({ copied: false });

        await expect(copyText("hello")).rejects.toThrow("The clipboard is not available");

        expect(fakeDocument.execCommand).toHaveBeenCalledOnce();
        expect(textarea.remove).toHaveBeenCalledOnce();
    });
});
