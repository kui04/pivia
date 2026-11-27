import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { cn } from "@/lib";
import type { TranscriptToolCallStep } from "@/stores/session";
import { mockClipboardSuccess, requireElement } from "@/storybook/dom";
import storyFrame from "@/storybook/frames.module.css";

import { TranscriptFrame } from "@/storybook/frames";
import { ToolCallBlock } from "./ToolCallBlock";

const longBashOutput = Array.from(
    { length: 24 },
    (_, index) => `a3d61${index.toString().padStart(2, "0")} feat(workspace): transcript step ${index + 1}`,
).join("\n");

const bashStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-bash",
    toolKind: "bash",
    toolName: "bash",
    summary: "git log --oneline -20",
    arguments: { command: "git log --oneline -20" },
    argumentsError: null,
    status: "done",
    output: longBashOutput,
    images: [],
    preview: { kind: "none" },
    warnings: [],
    nestedCalls: null,
    timing: { kind: "static", durationMs: 120 },
};

const runningStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-running",
    toolKind: "bash",
    toolName: "bash",
    summary: "pnpm test:unit",
    arguments: { command: "pnpm test:unit" },
    argumentsError: null,
    status: "running",
    output: Array.from({ length: 18 }, (_, index) => `RUN test suite ${index + 1}...`).join("\n"),
    images: [],
    preview: { kind: "none" },
    warnings: [],
    nestedCalls: null,
    timing: { kind: "since", startedAtMs: Date.now() - 1_500 },
};

const errorStep: TranscriptToolCallStep = {
    kind: "toolCall",
    id: "tool-error",
    toolKind: "edit",
    toolName: "edit",
    summary: "src/App.tsx",
    arguments: { path: "src/App.tsx" },
    argumentsError: null,
    status: "error",
    output: "Error: Target text was not found in src/App.tsx",
    images: [],
    preview: { kind: "none" },
    warnings: [],
    nestedCalls: null,
    timing: { kind: "static", durationMs: 42 },
};

const builtinAndGenericSteps: readonly TranscriptToolCallStep[] = [
    { ...bashStep, id: "kind-bash", toolKind: "bash", toolName: "bash", summary: "git status -s" },
    { ...bashStep, id: "kind-ps", toolKind: "powershell", toolName: "powershell", summary: "Get-ChildItem src" },
    {
        ...bashStep,
        id: "kind-read",
        toolKind: "read",
        toolName: "read",
        summary: "src/pages/Workspace/WorkspacePage.tsx",
    },
    {
        ...bashStep,
        id: "kind-write",
        toolKind: "write",
        toolName: "write",
        summary: "src/pages/Workspace/useWorkspaceSession.ts",
    },
    { ...bashStep, id: "kind-edit", toolKind: "edit", toolName: "edit", summary: "package.json" },
    { ...bashStep, id: "kind-grep", toolKind: "grep", toolName: "grep", summary: '"ScrollArea" in src' },
    { ...bashStep, id: "kind-find", toolKind: "find", toolName: "find", summary: "**/*.stories.tsx in src" },
    { ...bashStep, id: "kind-ls", toolKind: "ls", toolName: "ls", summary: "src/pages/Workspace" },
    { ...bashStep, id: "kind-code", toolKind: "codemode", toolName: "codemode", summary: "return 1;" },
    {
        ...bashStep,
        id: "kind-search",
        toolKind: "tool_search",
        toolName: "tool_search",
        summary: "github pull request",
    },
    {
        ...bashStep,
        id: "kind-generic",
        toolKind: "generic",
        toolName: "github_search_code",
        summary: "query=TurnGroup",
    },
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
    decorators: [TranscriptFrame],
} satisfies Meta<typeof ToolCallBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BashCollapsed: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: /Bash/ });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.getByText("120ms")).toBeVisible();

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

        const clipboard = mockClipboardSuccess();
        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy output" }));
            await waitFor(async () => {
                await expect(canvas.getByRole("status")).toHaveTextContent("Copied");
            });
            await expect(clipboard.writeText).toHaveBeenCalledWith(longBashOutput);
            await expect(args.onCopy).toHaveBeenCalledWith(longBashOutput);
        } finally {
            clipboard.restore();
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

        await expect(timer).toHaveTextContent(/^\d+ms$|^\d+\.\ds$/);
        await waitFor(async () => {
            await expect(timer.textContent).not.toBe("0ms");
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
        const root = requireElement(trigger.parentElement, "the disclosure root");
        await expect(root).toHaveAttribute("data-tone", "error");
        await expect(canvas.getByText(/Target text was not found/)).toBeVisible();
    },
};

export const EditDiff: Story = {
    args: {
        step: {
            kind: "toolCall",
            id: "tool-edit-diff",
            toolKind: "edit",
            toolName: "edit",
            summary: "src/App.tsx",
            arguments: { path: "src/App.tsx" },
            argumentsError: null,
            status: "done",
            output: "Successfully replaced 1 block(s) in src/App.tsx.",
            images: [],
            preview: {
                kind: "diff",
                diff: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -10,3 +10,3 @@\n const title = 'old';\n-const count = 1;\n+const count = 2;\n export { title, count };",
            },
            warnings: [],
            nestedCalls: null,
            timing: { kind: "static", durationMs: 80 },
        },
        defaultOpen: true,
    },
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("diff")).toBeVisible();
        await expect(canvas.getByText("const count = 1;")).toBeVisible();
        await expect(canvas.getByText("const count = 2;")).toBeVisible();

        const clipboard = mockClipboardSuccess();
        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy code" }));
            await waitFor(async () => {
                await expect(canvas.getByRole("status")).toHaveTextContent("Copied");
            });
            await expect(args.onCopy).toHaveBeenCalled();
        } finally {
            clipboard.restore();
        }
    },
};

export const WriteCodePreview: Story = {
    args: {
        step: {
            kind: "toolCall",
            id: "tool-write-code",
            toolKind: "write",
            toolName: "write",
            summary: "src/helper.ts",
            arguments: {
                path: "src/helper.ts",
                content: "export function greet(name: string): string {\n    return `Hello, ${name}`;\n}\n",
            },
            argumentsError: null,
            status: "done",
            output: "Successfully wrote to src/helper.ts",
            images: [],
            preview: {
                kind: "code",
                code: "export function greet(name: string): string {\n    return `Hello, ${name}`;\n}",
                language: "typescript",
                startLine: 1,
            },
            warnings: [],
            nestedCalls: null,
            timing: { kind: "static", durationMs: 65 },
        },
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("typescript")).toBeVisible();
        await expect(canvas.getByText(/Hello, \$\{name\}/)).toBeVisible();
        await expect(canvas.queryByText("Successfully wrote to src/helper.ts")).not.toBeInTheDocument();
    },
};

export const ReadWithWarnings: Story = {
    args: {
        step: {
            kind: "toolCall",
            id: "tool-read-warn",
            toolKind: "read",
            toolName: "read",
            summary: "src/store.ts:15-17",
            arguments: { path: "src/store.ts", offset: 15, limit: 3 },
            argumentsError: null,
            status: "done",
            output: "const first = 1;\nconst second = 2;\nconst third = 3;",
            images: [],
            preview: {
                kind: "code",
                code: "const first = 1;\nconst second = 2;\nconst third = 3;",
                language: "typescript",
                startLine: 15,
            },
            warnings: [
                { kind: "fullOutput", path: "/tmp/pi-read-full.log" },
                { kind: "notice", message: "Truncated: showing 3 of 2500 lines (2000 line limit)" },
            ],
            nestedCalls: null,
            timing: { kind: "static", durationMs: 35 },
        },
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("src/store.ts:15-17")).toBeVisible();
        await expect(canvas.getByText("Full output: /tmp/pi-read-full.log")).toBeVisible();
        await expect(canvas.getByText(/Truncated: showing 3 of 2500 lines/)).toBeVisible();
    },
};

export const CodemodeScriptWithNestedCalls: Story = {
    args: {
        step: {
            kind: "toolCall",
            id: "tool-codemode",
            toolKind: "codemode",
            toolName: "codemode",
            summary: "const files = await tools.find({ pattern: '*.ts' });",
            arguments: {
                code: "const files = await tools.find({ pattern: '*.ts' });\nconsole.log(files.join('\\n'));",
            },
            argumentsError: null,
            status: "done",
            output: "src/index.ts\nsrc/app.ts",
            images: [],
            preview: {
                kind: "script",
                code: "const files = await tools.find({ pattern: '*.ts' });\nconsole.log(files.join('\\n'));",
                language: "javascript",
            },
            warnings: [{ kind: "fullOutput", path: "/tmp/pi-codemode-full.log" }],
            nestedCalls: {
                calls: [
                    {
                        id: "cm/1",
                        name: "find",
                        args: '{"pattern":"*.ts"}',
                        status: "ok",
                        durationMs: 14,
                        error: null,
                        cost: null,
                    },
                    {
                        id: "cm/2",
                        name: "models.classify",
                        args: '{"label":"frontend"}',
                        status: "ok",
                        durationMs: 420,
                        error: null,
                        cost: 0.0015,
                    },
                    {
                        id: "cm/3",
                        name: "models.classify",
                        args: '{"label":"backend"}',
                        status: "error",
                        durationMs: 1200,
                        error: "Timeout waiting for classifier response",
                        cost: 0.0025,
                    },
                ],
                complete: false,
                totalCost: 0.004,
            },
            timing: { kind: "static", durationMs: 1650 },
        },
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("javascript")).toBeVisible();
        await expect(canvas.getByText("find")).toBeVisible();
        await expect(canvas.getByText("14ms")).toBeVisible();
        await expect(canvas.getByText("1.2s")).toBeVisible();
        await expect(canvas.getByText(/Timeout waiting for classifier response/)).toBeVisible();
        await expect(canvas.getByText("Model calls: $0.0040")).toBeVisible();
        await expect(canvas.getByText(/Nested call log truncated or incomplete/)).toBeVisible();
        await expect(canvas.getByText(/src\/index\.ts/)).toBeVisible();
        await expect(canvas.getByText("Full output: /tmp/pi-codemode-full.log")).toBeVisible();
    },
};

export const BuiltinAndGenericIcons: Story = {
    render: () => (
        <div className={cn(storyFrame.frame, storyFrame.stack)}>
            {builtinAndGenericSteps.map((step) => (
                <ToolCallBlock key={step.id} step={step} />
            ))}
        </div>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getAllByRole("button")).toHaveLength(builtinAndGenericSteps.length);
        for (const label of [
            "Bash",
            "PowerShell",
            "Read",
            "Write",
            "Edit",
            "Grep",
            "Find",
            "Ls",
            "Codemode",
            "Tool search",
            "github_search_code",
        ]) {
            await expect(canvas.getByText(label)).toBeVisible();
        }
    },
};
