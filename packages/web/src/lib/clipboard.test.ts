import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Clipboard } from "./clipboard";

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

describe("Clipboard.copy", () => {
    it("writes through the async clipboard API when it is available", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });

        await Clipboard.copy("hello");

        expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("uses the legacy copy path when the async API is missing", async () => {
        vi.stubGlobal("navigator", {});
        const { fakeDocument, textarea } = installLegacyClipboard({ copied: true });

        await Clipboard.copy("hello");

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

        await Clipboard.copy("hello");

        expect(previousFocus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    });

    it("falls back when the async API rejects", async () => {
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const { fakeDocument } = installLegacyClipboard({ copied: true });

        await Clipboard.copy("hello");

        expect(writeText).toHaveBeenCalledOnce();
        expect(fakeDocument.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    });

    it("rejects when both paths fail and still removes the temporary textarea", async () => {
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const { fakeDocument, textarea } = installLegacyClipboard({ copied: false });

        await expect(Clipboard.copy("hello")).rejects.toThrow("The clipboard is not available");

        expect(fakeDocument.execCommand).toHaveBeenCalledOnce();
        expect(textarea.remove).toHaveBeenCalledOnce();
    });
});

describe("Clipboard.hasFiles", () => {
    it("detects DataTransfer files and file-kind items", () => {
        expect(Clipboard.hasFiles(null)).toBe(false);

        const png = new File(["png"], "shot.png", { type: "image/png" });
        expect(
            Clipboard.hasFiles({
                files: [png] as unknown as FileList,
                items: [] as unknown as DataTransferItemList,
            } as DataTransfer),
        ).toBe(true);

        expect(
            Clipboard.hasFiles({
                files: [] as unknown as FileList,
                items: [{ kind: "string" }, { kind: "file" }] as unknown as DataTransferItemList,
            } as DataTransfer),
        ).toBe(true);

        expect(
            Clipboard.hasFiles({
                files: [] as unknown as FileList,
                items: [{ kind: "string" }] as unknown as DataTransferItemList,
            } as DataTransfer),
        ).toBe(false);
    });
});

describe("Clipboard.readFiles", () => {
    it("prefers DataTransfer files and falls back to item.getAsFile and navigator.clipboard.read", async () => {
        const directFile = new File(["a"], "a.png", { type: "image/png" });
        const fromDirect = await Clipboard.readFiles({
            files: [directFile] as unknown as FileList,
            items: [] as unknown as DataTransferItemList,
        } as DataTransfer);
        expect(fromDirect).toEqual([directFile]);

        const itemFile = new File(["b"], "b.png", { type: "image/png" });
        const fromItems = await Clipboard.readFiles({
            files: [] as unknown as FileList,
            items: [{ kind: "file", getAsFile: () => itemFile }] as unknown as DataTransferItemList,
        } as DataTransfer);
        expect(fromItems).toEqual([itemFile]);

        const webBlob = new Blob(["web"], { type: "image/webp" });
        vi.stubGlobal("navigator", {
            clipboard: {
                read: vi.fn().mockResolvedValue([
                    {
                        types: ["text/plain", "image/webp"],
                        getType: vi.fn().mockResolvedValue(webBlob),
                    },
                ]),
            },
        });
        const fromWeb = await Clipboard.readFiles(null);
        expect(fromWeb).toHaveLength(1);
        expect(fromWeb[0]?.type).toBe("image/webp");
    });
});

describe("Clipboard.blobToBase64", () => {
    it("strips the data URL prefix when encoding a Blob", async () => {
        const blob = new Blob(["hello"], { type: "text/plain" });
        await expect(Clipboard.blobToBase64(blob)).resolves.toBe(btoa("hello"));
    });
});
