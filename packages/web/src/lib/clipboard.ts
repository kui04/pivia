/** Clipboard actions for application code. */
export type Clipboard = {
    /** Writes plain text; rejects with a plain Error when both paths fail. */
    copy(text: string): Promise<void>;
    /** Returns true when a paste `DataTransfer` carries files or non-text clipboard items. */
    hasFiles(transfer: DataTransfer | null): boolean;
    /** Extracts files from `DataTransfer`, falling back to `navigator.clipboard.read()` when empty. */
    readFiles(transfer: DataTransfer | null): Promise<readonly File[]>;
    /** Encodes a `Blob` or `File` to raw base64 without a `data:` prefix. */
    blobToBase64(blob: Blob): Promise<string>;
};

const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Writes plain text to the system clipboard.
 *
 * `navigator.clipboard.writeText` is the current API (MDN: Baseline widely
 * available since 2020), but it only runs in a secure context and rejects when
 * the document is unfocused or the permission is denied. `execCommand("copy")`
 * is deprecated, yet it is the only path left when the async API is missing or
 * rejects, so it runs second as a best-effort fallback.
 *
 * Rejects with a plain Error when both paths fail.
 */
async function copy(text: string): Promise<void> {
    // `clipboard` is absent on insecure origins, but the DOM types declare it always present.
    const clipboard = navigator.clipboard as globalThis.Clipboard | undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
        try {
            await clipboard.writeText(text);
            return;
        } catch {
            // Permission or focus errors still leave the legacy path available.
        }
    }

    if (!copyWithExecCommand(text)) {
        throw new Error("The clipboard is not available");
    }
}

function hasFiles(transfer: DataTransfer | null): boolean {
    if (transfer === null) {
        return false;
    }
    if (transfer.files.length > 0) {
        return true;
    }
    for (const item of Array.from(transfer.items)) {
        if (item.kind === "file") {
            return true;
        }
    }
    return false;
}

function extractTransferFiles(transfer: DataTransfer | null): File[] {
    if (transfer === null) {
        return [];
    }
    if (transfer.files.length > 0) {
        return Array.from(transfer.files);
    }
    const files: File[] = [];
    for (const item of Array.from(transfer.items)) {
        if (item.kind === "file") {
            const file = item.getAsFile();
            if (file !== null) {
                files.push(file);
            }
        }
    }
    return files;
}

function defaultClipboardFileName(mimeType: string): string {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim();
    if (mimeType.startsWith("image/")) {
        return subtype !== undefined && subtype.length > 0 ? `Pasted image.${subtype}` : "Pasted image";
    }
    return subtype !== undefined && subtype.length > 0 ? `pasted-file.${subtype}` : "pasted-file";
}

async function readFiles(transfer: DataTransfer | null): Promise<readonly File[]> {
    const fromTransfer = extractTransferFiles(transfer);
    if (fromTransfer.length > 0) {
        return fromTransfer;
    }
    if (typeof navigator === "undefined") {
        return [];
    }
    // `clipboard` is absent on insecure origins, but the DOM types declare it always present.
    const clipboard = navigator.clipboard as globalThis.Clipboard | undefined;
    if (clipboard === undefined || typeof clipboard.read !== "function") {
        return [];
    }

    try {
        const items = await clipboard.read();
        const files: File[] = [];
        for (const item of items) {
            const preferredType =
                item.types.find((type) => type.startsWith("image/")) ??
                item.types.find((type) => !type.startsWith("text/"));
            if (preferredType === undefined) {
                continue;
            }
            const blob = await item.getType(preferredType);
            const mimeType = blob.type.length > 0 ? blob.type : preferredType;
            files.push(
                blob instanceof File ? blob : new File([blob], defaultClipboardFileName(mimeType), { type: mimeType }),
            );
        }
        return files;
    } catch {
        return [];
    }
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)));
    }
    return btoa(chunks.join(""));
}

/** The app-wide clipboard action. */
export const Clipboard: Clipboard = { copy, hasFiles, readFiles, blobToBase64 };

/**
 * The legacy copy path. It needs user activation. When the async API is absent it
 * runs before any await; when the async API rejects, activation may already be gone,
 * so a false result is possible and the caller sees the copy as failed.
 */
function copyWithExecCommand(text: string): boolean {
    const previousFocus = document.activeElement;
    const textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);

    // Selecting explicitly is what iOS Safari (and some WebKit builds) need; it is
    // harmless everywhere else.
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    try {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- The only fallback when the async clipboard API is missing or rejects.
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        textarea.remove();
        if (previousFocus instanceof HTMLElement) {
            previousFocus.focus({ preventScroll: true });
        }
    }
}
