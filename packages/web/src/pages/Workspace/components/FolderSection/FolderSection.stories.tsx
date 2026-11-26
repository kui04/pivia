import { parseSessionId, type SessionId } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import type { FolderSection as FolderSectionModel, SessionRow as SessionRowModel } from "@/stores/workspace";

import { FolderSection } from "./FolderSection";
import styles from "./FolderSection.stories.module.css";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid story session id: ${raw}`);
    }
    return parsed;
}

const NOW = Date.parse("2026-01-03T12:00:00.000Z");

function row(id: string, title: string): SessionRowModel {
    return {
        id: sid(id),
        title,
        named: true,
        cwd: "/home/u/pivia",
        modifiedAtMs: NOW - 30 * 60 * 1000,
        runtimeState: "idle",
        attachedClients: 0,
        pinned: false,
        selected: false,
    };
}

const folder: FolderSectionModel = {
    cwd: "/home/u/pivia",
    label: "pivia",
    collapsed: false,
    sessions: [row("session-a", "Fix the session list"), row("session-b", "Rewrite the sidebar")],
};

const meta = {
    title: "Pages/Workspace/FolderSection",
    component: FolderSection,
    args: {
        folder,
        nowMs: NOW,
        closingIds: new Set<SessionId>(),
        onToggle: fn(),
        onSelect: fn(),
        onTogglePinned: fn(),
        onCopySessionId: fn(),
        onCloseSession: fn(),
    },
    argTypes: {
        folder: { control: false },
        closingIds: { control: false },
        onToggle: { control: false },
        onSelect: { control: false },
        onTogglePinned: { control: false },
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
} satisfies Meta<typeof FolderSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
    play: async ({ canvasElement, userEvent, args }) => {
        args.onToggle.mockClear();
        const canvas = within(canvasElement);

        const header = canvas.getByRole("button", { name: /pivia/ });
        await expect(header).toHaveAttribute("aria-expanded", "true");
        await expect(header).toHaveAccessibleName(/\/home\/u\/pivia/);
        await expect(canvas.getAllByRole("listitem")).toHaveLength(2);

        await userEvent.click(header);
        await expect(args.onToggle).toHaveBeenCalledTimes(1);
    },
};

export const Collapsed: Story = {
    args: {
        folder: { ...folder, collapsed: true },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("button", { name: /pivia/ })).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.getByText("pivia")).toBeVisible();
        await expect(canvasElement.querySelector("ul")).not.toBeInTheDocument();
        await expect(canvas.queryByText("Fix the session list")).not.toBeInTheDocument();
    },
};
