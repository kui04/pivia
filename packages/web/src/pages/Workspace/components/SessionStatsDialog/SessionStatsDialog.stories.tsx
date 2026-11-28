import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionModelInfo, SessionStateSnapshot } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { makeStorySessionState } from "@/storybook/fixtures";
import { sid } from "@/storybook/ids";

import { SessionStatsDialog } from "./SessionStatsDialog";

const SESSION_ID = sid("stats-session");
const MODEL: SessionModelInfo = {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    reasoning: true,
};

const usage = (input: number, output: number, cacheRead: number, cost: number): AssistantMessage["usage"] => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const entries: readonly FileEntry[] = [
    {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: "Summarize the diff", timestamp: 1 },
    },
    {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: usage(1_000, 500, 200, 0.012345),
            stopReason: "stop",
            timestamp: 2,
        },
    },
];

const state: SessionStateSnapshot = makeStorySessionState(SESSION_ID, {
    model: MODEL,
    thinkingLevel: "medium",
    contextUsage: { tokens: 45_000, contextWindow: 200_000, percent: 22.5 },
});

const meta = {
    title: "Pages/Workspace/SessionStatsDialog",
    component: SessionStatsDialog,
    args: {
        open: true,
        onOpenChange: () => undefined,
        state,
        entries,
    },
} satisfies Meta<typeof SessionStatsDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async () => {
        const dialog = await within(document.body).findByRole("dialog", { name: "Session stats" });

        await expect(within(dialog).getByText(String(SESSION_ID))).toBeVisible();
        await expect(within(dialog).getByText("/home/u/pivia")).toBeVisible();
        await expect(within(dialog).getByText("Claude Sonnet 4")).toBeVisible();
        await expect(dialog).toHaveTextContent("22.5% of 200k (auto compaction)");
        await expect(dialog).toHaveTextContent("1 user, 1 assistant, 0 tool results, 2 total");
        await expect(dialog).toHaveTextContent("1000 input, 500 output, 200 cache read, 0 cache write");
        await expect(dialog).toHaveTextContent("16.7%");
        await expect(dialog).toHaveTextContent("$0.0123");
        await expect(within(dialog).queryByText(/sessionFile/)).not.toBeInTheDocument();
    },
};
