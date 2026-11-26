import { describe, expect, it } from "vitest";

import { formatAttachmentError, readImageFiles } from "./attachments";

describe("readImageFiles", () => {
    it("reads valid image files into StagedImageAttachment items with base64 content", async () => {
        const png = new File(["png-bytes"], "diagram.png", { type: "image/png" });
        const result = await readImageFiles([png]);

        expect(result.errors).toEqual([]);
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments[0]).toMatchObject({
            name: "diagram.png",
            byteLength: 9,
            image: {
                type: "image",
                mimeType: "image/png",
                data: btoa("png-bytes"),
            },
        });
    });

    it("rejects non-image files and oversized images with typed errors", async () => {
        const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
        const hugeImage = new File(["0123456789"], "huge.png", { type: "image/png" });

        const result = await readImageFiles([textFile, hugeImage], 5);

        expect(result.attachments).toEqual([]);
        expect(result.errors).toEqual([
            { kind: "unsupported_type", name: "notes.txt", mimeType: "text/plain" },
            { kind: "too_large", name: "huge.png", byteLength: 10, maxBytes: 5 },
        ]);
    });
});

describe("formatAttachmentError", () => {
    it("formats typed attachment errors using Formatter.byteSize", () => {
        expect(
            formatAttachmentError({ kind: "unsupported_type", name: "doc.pdf", mimeType: "application/pdf" }),
        ).toContain("doc.pdf");
        expect(
            formatAttachmentError({ kind: "too_large", name: "big.png", byteLength: 2048, maxBytes: 1024 }),
        ).toContain("1.0KB");
        expect(formatAttachmentError({ kind: "read_failed", name: "a.png", message: "boom" })).toContain("boom");
    });
});
