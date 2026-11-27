import { type SessionId } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";

import { makeStorySessionRow, STORY_NOW } from "@/storybook/fixtures";
import type { CatalogSyncPhase, WorkspaceModel } from "@/stores/workspace";

import { Sidebar, type SidebarProps } from "./Sidebar";
import styles from "./Sidebar.stories.module.css";

const row = makeStorySessionRow;

const populated: WorkspaceModel = {
    pinned: [row("session-1", "Parser rewrite", { pinned: true, selected: true })],
    folders: [
        {
            cwd: "/home/u/pivia",
            label: "pivia",
            collapsed: false,
            sessions: [
                row("session-2", "Fix the session list"),
                row("session-3", "A long title that truncates before pushing the age out", {
                    named: false,
                    runtimeState: "streaming",
                    attachedClients: 1,
                }),
            ],
        },
        {
            cwd: "/home/u/notes",
            label: "notes",
            collapsed: true,
            sessions: [row("session-4", "Draft", { cwd: "/home/u/notes" })],
        },
    ],
    total: 4,
    matched: 4,
};

const empty: WorkspaceModel = {
    pinned: [],
    folders: [],
    total: 0,
    matched: 0,
};

function StatefulSidebar({ query, onQueryChange, ...rest }: SidebarProps) {
    const [text, setText] = useState(query);

    return (
        <Sidebar
            {...rest}
            query={text}
            onQueryChange={(next) => {
                setText(next);
                onQueryChange(next);
            }}
        />
    );
}

const live: CatalogSyncPhase = { kind: "live" };

const meta = {
    title: "Pages/Workspace/Sidebar",
    component: Sidebar,
    args: {
        model: populated,
        sync: live,
        query: "",
        nowMs: STORY_NOW,
        closingIds: new Set<SessionId>(),
        onQueryChange: fn(),
        onRefresh: fn(),
        onNewSession: fn(),
        onOpenSettings: fn(),
        onSelect: fn(),
        onTogglePinned: fn(),
        onToggleFolder: fn(),
        onCopySessionId: fn(),
        onCloseSession: fn(),
    },
    argTypes: {
        model: { control: false },
        sync: { control: false },
        closingIds: { control: false },
        onQueryChange: { control: false },
        onRefresh: { control: false },
        onNewSession: { control: false },
        onOpenSettings: { control: false },
        onSelect: { control: false },
        onTogglePinned: { control: false },
        onToggleFolder: { control: false },
        onCopySessionId: { control: false },
        onCloseSession: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Sidebar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        // The session list is a page-level scroller, so it keeps the landmark.
        await expect(canvas.getByRole("region", { name: "Sessions" })).toHaveAttribute(
            "data-slot",
            "scroll-area-viewport",
        );
        await expect(canvas.getByRole("button", { name: "New session" })).toBeEnabled();
        await expect(canvas.getByRole("button", { name: "Settings" })).toBeEnabled();
        await expect(canvas.getByText("Pinned")).toBeVisible();
        await expect(canvas.getByRole("img", { name: "Streaming" })).toBeVisible();
    },
};

export const LoadingSkeleton: Story = {
    args: {
        model: empty,
        sync: { kind: "syncing" },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Loading sessions");
        await expect(canvas.getByRole("button", { name: "Refresh sessions" })).toHaveAttribute("aria-disabled", "true");
    },
};

export const Empty: Story = {
    args: {
        model: empty,
        sync: live,
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByText("No sessions yet. Create one to start.")).toBeVisible();
    },
};

export const Reconnecting: Story = {
    args: {
        sync: { kind: "reconnecting", attempt: 2 },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Reconnecting to server");
        await expect(canvas.getByText("Fix the session list")).toBeVisible();
    },
};

export const SearchInteraction: Story = {
    render: (args) => <StatefulSidebar {...args} />,
    play: async ({ canvasElement, userEvent, args }) => {
        args.onNewSession.mockClear();
        args.onQueryChange.mockClear();
        args.onRefresh.mockClear();
        args.onOpenSettings.mockClear();

        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "New session" }));
        await expect(args.onNewSession).toHaveBeenCalledTimes(1);

        await userEvent.click(canvas.getByRole("button", { name: "Refresh sessions" }));
        await expect(args.onRefresh).toHaveBeenCalledTimes(1);

        await userEvent.click(canvas.getByRole("button", { name: "Settings" }));
        await expect(args.onOpenSettings).toHaveBeenCalledTimes(1);

        await userEvent.click(canvas.getByRole("button", { name: "Search" }));
        const input = await canvas.findByRole("searchbox", { name: "Search sessions" });
        await userEvent.type(input, "parser");
        await expect(args.onQueryChange).toHaveBeenLastCalledWith("parser");

        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(canvas.getByRole("button", { name: "Search" })).toBeVisible());
        await expect(args.onQueryChange).toHaveBeenLastCalledWith("");
    },
};
