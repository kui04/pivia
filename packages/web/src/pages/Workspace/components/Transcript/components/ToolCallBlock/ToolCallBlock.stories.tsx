import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, spyOn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptToolCallStep } from "@/stores/session/transcript";

import { ToolCallBlock } from "./ToolCallBlock";
import styles from "./ToolCallBlock.stories.module.css";

function requireElement<T extends Element>(element: T | null, name: string): T {
    if (element === null) {
        throw new Error(`The story did not render ${name}`);
    }
    return element;
}

const longBashOutput = Array.from(
    { length: 24 },
    (_, index) => `a3d61${index.toString().padStart(2, "0")} feat(workspace): transcript step ${index + 1}`,
).join("\n");

const bashStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-bash",
    name: "bash",
    toolKind: "bash",
    label: "Bash",
    summary: "git log --oneline -20",
    arguments: { command: "git log --oneline -20" },
    argumentsError: null,
    status: "done",
    output: longBashOutput,
    images: [],
    timing: { kind: "static", durationMs: 120 },
};

const runningStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-running",
    name: "bash",
    toolKind: "bash",
    label: "Bash",
    summary: "pnpm test:unit",
    arguments: { command: "pnpm test:unit" },
    argumentsError: null,
    status: "running",
    output: Array.from({ length: 18 }, (_, index) => `RUN test suite ${index + 1}...`).join("\n"),
    images: [],
    timing: { kind: "since", startedAtMs: Date.now() - 1_500 },
};

const errorStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-error",
    name: "edit",
    toolKind: "edit",
    label: "Edit",
    summary: "src/App.tsx",
    arguments: { path: "src/App.tsx" },
    argumentsError: null,
    status: "error",
    output: "Error: Target text was not found in src/App.tsx",
    images: [],
    timing: { kind: "static", durationMs: 42 },
};

const builtinAndGenericSteps: readonly TranscriptToolCallStep[] = [
    { ...bashStep, id: "kind-bash", toolKind: "bash", label: "Bash", summary: "git status -s" },
    { ...bashStep, id: "kind-ps", toolKind: "powershell", label: "PowerShell", summary: "Get-ChildItem src" },
    { ...bashStep, id: "kind-read", toolKind: "read", label: "Read", summary: "src/pages/Workspace/WorkspacePage.tsx" },
    {
        ...bashStep,
        id: "kind-write",
        toolKind: "write",
        label: "Write",
        summary: "src/pages/Workspace/useWorkspaceSession.ts",
    },
    { ...bashStep, id: "kind-edit", toolKind: "edit", label: "Edit", summary: "package.json" },
    { ...bashStep, id: "kind-grep", toolKind: "grep", label: "Grep", summary: '"ScrollArea" in src' },
    { ...bashStep, id: "kind-find", toolKind: "find", label: "Find", summary: "**/*.stories.tsx in src" },
    { ...bashStep, id: "kind-ls", toolKind: "ls", label: "Ls", summary: "src/pages/Workspace" },
    { ...bashStep, id: "kind-code", toolKind: "codemode", label: "Codemode", summary: "return 1;" },
    { ...bashStep, id: "kind-search", toolKind: "tool_search", label: "Tool search", summary: "github pull request" },
    { ...bashStep, id: "kind-generic", toolKind: "generic", label: "github_search_code", summary: "query=TurnGroup" },
];

const meta = {
    title: "Pages/Workspace/Transcript/ToolCallBlock",
    component: ToolCallBlock,
    args: {
        step: bashStep,
        onOpenChange: fn(),
        onCopy: fn(),
    },
    argTypes: {
        step: { control: false },
        onOpenChange: { control: false },
        onCopy: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof ToolCallBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BashCollapsed: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: /Bash/ });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.getByText("0.1s")).toBeVisible();

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
        await expect(canvas.getByText(/a3d6100 feat\(workspace\)/)).toBeVisible();
    },
};

export const BashExpanded: Story = {
    args: {
        defaultOpen: true,
    },
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const viewport = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"),
            "the tool output viewport",
        );
        const card = requireElement(canvasElement.querySelector<HTMLElement>("div[data-status='done']"), "card");
        const pre = requireElement(canvasElement.querySelector("pre"), "output pre");

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(card).toHaveAttribute("data-fade-bottom", "true");
        });
        await expect(pre).not.toHaveAttribute("data-wrapped");

        const wrapButton = canvas.getByRole("button", { name: "Wrap lines" });
        await expect(wrapButton).toHaveAttribute("aria-pressed", "false");

        await userEvent.click(wrapButton);
        await expect(wrapButton).toHaveAttribute("aria-pressed", "true");
        await expect(pre).toHaveAttribute("data-wrapped", "true");

        const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy output" }));
            await waitFor(async () => {
                await expect(canvas.getByRole("status")).toHaveTextContent("Copied");
            });
            await expect(writeText).toHaveBeenCalledWith(longBashOutput);
            await expect(args.onCopy).toHaveBeenCalledWith(longBashOutput);
        } finally {
            writeText.mockRestore();
        }
    },
};

export const Running: Story = {
    args: {
        step: runningStep,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const timer = await waitFor(() =>
            requireElement(canvasElement.querySelector<HTMLElement>("[data-running='true']"), "running timer"),
        );
        const viewport = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"),
            "the running viewport",
        );

        await expect(timer).toHaveTextContent(/^\d+\.\ds$/);
        await waitFor(async () => {
            await expect(timer.textContent).not.toBe("0.0s");
            await expect(viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight)).toBeLessThanOrEqual(4);
        });
    },
};

export const ErrorResult: Story = {
    args: {
        step: errorStep,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: /Edit/ });
        await expect(trigger).toHaveAttribute("data-status", "error");
        await expect(canvas.getByText(/Target text was not found/)).toBeVisible();
    },
};

export const BuiltinAndGenericIcons: Story = {
    render: () => (
        <div className={styles.stack}>
            {builtinAndGenericSteps.map((step) => (
                <ToolCallBlock key={step.id} step={step} />
            ))}
        </div>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getAllByRole("button")).toHaveLength(builtinAndGenericSteps.length);
        await expect(canvas.getByText("github_search_code")).toBeVisible();
    },
};
