import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionModelInfo, SessionStateSnapshot } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { makeStorySessionState } from "@/storybook/fixtures";
import { sid } from "@/storybook/ids";

import { SessionStatusBar } from "./SessionStatusBar";

const SESSION_ID = sid("status-session");
const MODEL: SessionModelInfo = {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    reasoning: true,
};

function usage(input: number, output: number, cacheRead: number, cost: number): AssistantMessage["usage"] {
    return {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

function assistantEntry(): FileEntry {
    return {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: usage(1_000, 500, 200, 0.012),
            stopReason: "stop",
            timestamp: 2,
        },
    };
}

const state = (overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot =>
    makeStorySessionState(SESSION_ID, {
        model: MODEL,
        thinkingLevel: "medium",
        contextUsage: { tokens: 45_000, contextWindow: 200_000, percent: 22.5 },
        ...overrides,
    });

const meta = {
    title: "Pages/Workspace/SessionStatusBar",
    component: SessionStatusBar,
    args: {
        state: state(),
        entries: [assistantEntry()],
    },
} satisfies Meta<typeof SessionStatusBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const bar = canvas.getByRole("group", { name: "Session status" });

        await expect(bar).toHaveTextContent("↑1.0k ↓500 R200 CH16.7% $0.012 22.5%/200k (auto)");
        await expect(bar).toHaveTextContent("Claude Sonnet 4 • medium");
    },
};

export const WarningContext: Story = {
    args: {
        state: state({ contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 80 } }),
    },
    play: async ({ canvasElement }) => {
        const bar = within(canvasElement).getByRole("group", { name: "Session status" });
        const context = bar.querySelector('[data-tone="warning"]');

        await expect(context).toHaveTextContent("80.0%/200k");
    },
};

export const ErrorContext: Story = {
    args: {
        state: state({ contextUsage: { tokens: 190_000, contextWindow: 200_000, percent: 95 } }),
    },
    play: async ({ canvasElement }) => {
        const bar = within(canvasElement).getByRole("group", { name: "Session status" });
        const context = bar.querySelector('[data-tone="error"]');

        await expect(context).toHaveTextContent("95.0%/200k");
    },
};

export const UnknownContext: Story = {
    args: { state: state({ contextUsage: null }), entries: [] },
    play: async ({ canvasElement }) => {
        const bar = within(canvasElement).getByRole("group", { name: "Session status" });

        await expect(bar).toHaveTextContent("No usage yet");
        await expect(bar).toHaveTextContent("?/200k");
    },
};

export const RoutedModel: Story = {
    args: {
        state: state({
            routedModel: {
                model: {
                    provider: "openai",
                    id: "gpt-5",
                    name: "GPT-5",
                    contextWindow: 272_000,
                    reasoning: true,
                },
                thinkingLevel: "high",
            },
        }),
    },
    play: async ({ canvasElement }) => {
        const bar = within(canvasElement).getByRole("group", { name: "Session status" });
        await expect(bar).toHaveTextContent("Claude Sonnet 4 • medium → gpt-5 • high");
    },
};
