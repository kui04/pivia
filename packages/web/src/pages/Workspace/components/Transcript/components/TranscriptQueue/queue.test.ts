import { describe, expect, it } from "vitest";

import { collectQueuedEntries } from "./queue";

describe("collectQueuedEntries", () => {
    it("keeps steering before follow-up and drops blank messages", () => {
        expect(
            collectQueuedEntries({
                steeringMessages: ["first", "   ", ""],
                followUpMessages: ["\n\t", "second"],
            }),
        ).toEqual([
            { kind: "steering", label: "Queued · Steering", text: "first" },
            { kind: "followUp", label: "Queued · Follow-up", text: "second" },
        ]);
    });

    it("returns no entries for empty or whitespace-only queues", () => {
        expect(collectQueuedEntries({ steeringMessages: [], followUpMessages: [] })).toEqual([]);
        expect(collectQueuedEntries({ steeringMessages: [" "], followUpMessages: [""] })).toEqual([]);
    });
});
