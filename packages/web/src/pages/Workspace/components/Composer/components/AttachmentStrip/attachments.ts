import { Clipboard, Formatter } from "@/lib";

import type { AttachmentId, AttachmentReadError, AttachmentReadResult, StagedImageAttachment } from "../../types";

/** Maximum single-image byte size accepted by the composer boundary (10 MiB). */
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
};

let nextAttachmentCounter = 0;

/** Construct a branded {@link AttachmentId} for a newly staged attachment. */
export function createAttachmentId(): AttachmentId {
    nextAttachmentCounter += 1;
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID() as AttachmentId;
    }
    return `attachment-${nextAttachmentCounter}` as AttachmentId;
}

function inferImageMimeType(file: File): string | null {
    if (file.type.startsWith("image/")) {
        return file.type;
    }
    const dot = file.name.lastIndexOf(".");
    if (dot === -1) {
        return null;
    }
    const ext = file.name.slice(dot + 1).toLowerCase();
    return SUPPORTED_IMAGE_EXTENSIONS[ext] ?? null;
}

/** Read and validate browser `File` objects into base64-backed {@link StagedImageAttachment} items. */
export async function readImageFiles(
    files: Iterable<File>,
    maxBytes: number = MAX_IMAGE_ATTACHMENT_BYTES,
): Promise<AttachmentReadResult> {
    const attachments: StagedImageAttachment[] = [];
    const errors: AttachmentReadError[] = [];

    for (const file of files) {
        const name = file.name.length > 0 ? file.name : "Pasted image";
        const mimeType = inferImageMimeType(file);
        if (mimeType === null) {
            errors.push({
                kind: "unsupported_type",
                name,
                mimeType: file.type.length > 0 ? file.type : "unknown",
            });
            continue;
        }
        if (file.size > maxBytes) {
            errors.push({
                kind: "too_large",
                name,
                byteLength: file.size,
                maxBytes,
            });
            continue;
        }
        try {
            const data = await Clipboard.blobToBase64(file);
            attachments.push({
                id: createAttachmentId(),
                name,
                byteLength: file.size,
                image: {
                    type: "image",
                    data,
                    mimeType,
                },
            });
        } catch (cause) {
            errors.push({
                kind: "read_failed",
                name,
                message: cause instanceof Error ? cause.message : String(cause),
            });
        }
    }

    return { attachments, errors };
}

/** Extract and validate pasted image files from a clipboard `DataTransfer`. */
export async function readClipboardImages(
    transfer: DataTransfer | null,
    maxBytes: number = MAX_IMAGE_ATTACHMENT_BYTES,
): Promise<AttachmentReadResult> {
    const files = await Clipboard.readFiles(transfer);
    if (files.length === 0) {
        return { attachments: [], errors: [] };
    }
    return readImageFiles(files, maxBytes);
}

/** Returns true when `transfer` carries at least one file or item that may hold an image. */
export function hasClipboardImageOrFiles(transfer: DataTransfer | null): boolean {
    return Clipboard.hasFiles(transfer);
}

/** Format a human-readable message for an {@link AttachmentReadError}. */
export function formatAttachmentError(error: AttachmentReadError): string {
    switch (error.kind) {
        case "unsupported_type":
            return `${error.name} is not a supported image (${error.mimeType}).`;
        case "too_large":
            return `${error.name} exceeds the ${Formatter.byteSize(error.maxBytes)} image limit.`;
        case "read_failed":
            return `Cannot read ${error.name}: ${error.message}`;
    }
}
