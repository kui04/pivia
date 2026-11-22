import { SESSION_CLOSE_CODE } from "@pivia/protocol";
import { describe, expect, it, vi } from "vitest";

import { createBackpressureSender, shouldOffloadPayload } from "./ws-guard.ts";

describe("ws-guard", () => {
    it("closes slow consumers with 1013 when bufferedAmount exceeds limit", () => {
        const warn = vi.fn();
        const close = vi.fn();
        const send = vi.fn();
        const onClose = vi.fn();
        const socket = {
            readyState: 1,
            bufferedAmount: 200,
            send,
            close,
        };
        const sender = createBackpressureSender(socket, { warn }, { maxBufferedBytes: 100, onClose });
        sender.sendRaw("hello");
        expect(send).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledWith(SESSION_CLOSE_CODE.slowConsumer, "Slow consumer");
        expect(onClose).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledOnce();

        // Subsequent sends are ignored once closed.
        socket.bufferedAmount = 0;
        sender.sendRaw("world");
        expect(send).not.toHaveBeenCalled();
    });

    it("evaluates item count and byte offload thresholds uniformly", () => {
        expect(shouldOffloadPayload({ itemCount: 1000, serializedBytes: 1024 })).toBe(false);
        expect(shouldOffloadPayload({ itemCount: 1001, serializedBytes: 1024 })).toBe(true);
        expect(shouldOffloadPayload({ itemCount: 10, serializedBytes: 512 * 1024 + 1 })).toBe(true);
    });
});
