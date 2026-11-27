import type { SessionModelInfo, SessionRpcCommand, SessionStateSnapshot } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, screen, userEvent, waitFor, within } from "storybook/test";

import type { SessionRpcResponseMessage } from "@/lib/transport";
import { sid } from "@/storybook/ids";
import { DarkTheme } from "@/storybook/theme";

import { requireElement } from "@/storybook/dom";
import { Composer } from "./Composer";
import styles from "./Composer.stories.module.css";

const SESSION_ID = sid("story-session");

const MODELS: readonly SessionModelInfo[] = [
    { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
];

function makeState(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: SESSION_ID,
        cwd: "/home/u/pivia",
        name: "Composer story",
        model: MODELS[0] ?? null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 2,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

const defaultSendCommand = fn((command: SessionRpcCommand): Promise<SessionRpcResponseMessage> => {
    switch (command.type) {
        case "get_available_models":
            return Promise.resolve({
                type: "rpc:response",
                command: command.type,
                success: true,
                data: { models: MODELS },
            });
        case "get_available_thinking_levels":
            return Promise.resolve({
                type: "rpc:response",
                command: command.type,
                success: true,
                data: { levels: ["off", "low", "medium", "high"] },
            });
        default:
            return Promise.resolve({ type: "rpc:response", command: command.type, success: true });
    }
});

const meta = {
    title: "Pages/Workspace/Composer",
    component: Composer,
    parameters: {
        layout: "fullscreen",
    },
    args: {
        sessionId: SESSION_ID,
        state: makeState(),
        connected: true,
        onSendCommand: defaultSendCommand,
        onNotify: fn(),
    },
    argTypes: {
        state: { control: false },
        onSendCommand: { control: false },
        onNotify: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Composer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement, args }) => {
        defaultSendCommand.mockClear();
        const canvas = within(canvasElement);
        const input = canvas.getByRole("textbox", { name: "Message" });

        await userEvent.type(input, "Summarize the changes");
        await userEvent.click(canvas.getByRole("button", { name: "Send message" }));

        await expect(defaultSendCommand).toHaveBeenCalledWith({
            type: "prompt",
            message: "Summarize the changes",
        });
        await expect(input).toHaveValue("");

        const modelButton = canvas.getByRole("button", { name: /^Model:/ });
        await userEvent.click(modelButton);
        const search = await screen.findByRole("combobox", { name: "Search models" });
        const modelPopup = requireElement(search.closest('[data-slot="popover"]'), "modelPopup");
        const modelOption = await screen.findByRole("option", { name: "Claude Sonnet 4" });
        const modelViewport = modelOption.closest('[data-slot="scroll-area-viewport"]');
        if (!(modelViewport instanceof HTMLElement)) {
            throw new Error("Missing model picker scroll viewport");
        }
        await expect(modelViewport.scrollWidth).toBeLessThanOrEqual(modelViewport.clientWidth);
        await waitFor(() =>
            expect(modelPopup.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                modelButton.getBoundingClientRect().top,
            ),
        );
        await userEvent.type(search, "gpt5");
        await userEvent.click(await screen.findByRole("option", { name: "GPT-5" }));
        await expect(defaultSendCommand).toHaveBeenCalledWith({
            type: "set_model",
            provider: "openai",
            modelId: "gpt-5",
        });

        const thinkingButton = canvas.getByRole("button", { name: /^Thinking level:/ });
        await userEvent.click(thinkingButton);
        const highOption = await screen.findByRole("option", { name: "high" });
        const thinkingPopup = requireElement(highOption.closest('[data-slot="popover"]'), "thinkingPopup");
        await waitFor(() =>
            expect(thinkingPopup.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                thinkingButton.getBoundingClientRect().top,
            ),
        );
        await userEvent.click(highOption);
        await expect(defaultSendCommand).toHaveBeenCalledWith({
            type: "set_thinking_level",
            level: "high",
        });

        await userEvent.type(input, "/comp");
        const compactOption = await screen.findByRole("option", { name: /\/compact/ });
        const commandViewport = compactOption.closest('[data-slot="scroll-area-viewport"]');
        if (!(commandViewport instanceof HTMLElement)) {
            throw new Error("Missing command list scroll viewport");
        }
        await expect(commandViewport.scrollWidth).toBeLessThanOrEqual(commandViewport.clientWidth);
        await userEvent.click(compactOption);
        await expect(input).toHaveValue("/compact ");
        await userEvent.keyboard("{Enter}");
        await expect(defaultSendCommand).toHaveBeenCalledWith({ type: "compact" });

        await userEvent.type(input, "/model{Enter}");
        await waitFor(() => expect(args.onNotify).toHaveBeenCalled());
    },
};

export const Streaming: Story = {
    args: {
        state: makeState({ isStreaming: true }),
    },
    play: async ({ canvasElement }) => {
        defaultSendCommand.mockClear();
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("button", { name: "Stop response" })).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Steer run" })).not.toBeInTheDocument();

        const input = canvas.getByRole("textbox", { name: "Message" });
        await userEvent.type(input, "Focus on tests");
        const steerButton = canvas.getByRole("button", { name: "Steer run" });
        await expect(steerButton).toBeVisible();

        await userEvent.click(steerButton);
        await expect(defaultSendCommand).toHaveBeenCalledWith({
            type: "prompt",
            message: "Focus on tests",
            streamingBehavior: "steer",
        });

        await userEvent.click(canvas.getByRole("button", { name: "Stop response" }));
        await expect(defaultSendCommand).toHaveBeenCalledWith({ type: "abort" });
    },
};

export const Attachments: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const fileInput = canvasElement.querySelector('input[type="file"]');
        if (!(fileInput instanceof HTMLInputElement)) {
            throw new Error("Missing file input");
        }
        const imageFile = new File(["fake-png"], "screenshot.png", { type: "image/png" });
        await userEvent.upload(fileInput, imageFile);

        const inspectButton = await canvas.findByRole("button", { name: "Inspect screenshot.png" });
        await expect(inspectButton).toBeVisible();
        await expect(canvas.getByText("screenshot.png")).toBeVisible();
        await expect(canvas.getByText("8B")).toBeVisible();

        await userEvent.click(inspectButton);
        const dialog = await screen.findByRole("dialog", { name: "Image viewer" });
        await expect(within(dialog).getByText("screenshot.png · 8B")).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image viewer" })).not.toBeInTheDocument());

        await userEvent.click(canvas.getByRole("button", { name: "Remove screenshot.png" }));
        await waitFor(() =>
            expect(canvas.queryByRole("button", { name: "Inspect screenshot.png" })).not.toBeInTheDocument(),
        );
    },
};

export const Unavailable: Story = {
    args: {
        connected: false,
        state: null,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("textbox", { name: "Message" })).toBeDisabled();
        await expect(canvas.getByRole("button", { name: /^Model:/ })).toBeDisabled();
        await expect(canvas.getByRole("button", { name: /^Thinking level:/ })).toBeDisabled();
    },
};

export const Dark: Story = {
    ...Default,
    decorators: [DarkTheme],
};

/** A distinct session id keeps this story off the catalog cache the other stories fill. */
const MANY_MODELS_SESSION = sid("story-session-many-models");

const MANY_MODELS: readonly SessionModelInfo[] = Array.from({ length: 20 }, (_, index) => ({
    provider: "openai",
    id: `story-model-${index}`,
    name: `Story model ${index}`,
}));

const manyModelsCommand = fn((command: SessionRpcCommand): Promise<SessionRpcResponseMessage> => {
    if (command.type === "get_available_models") {
        return Promise.resolve({
            type: "rpc:response",
            command: command.type,
            success: true,
            data: { models: MANY_MODELS },
        });
    }
    return defaultSendCommand(command);
});

export const HoverDoesNotScroll: Story = {
    args: {
        sessionId: MANY_MODELS_SESSION,
        state: makeState({ sessionId: MANY_MODELS_SESSION }),
        onSendCommand: manyModelsCommand,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: /^Model:/ }));

        const firstOption = await screen.findByRole("option", { name: "Story model 0" });
        const viewport = firstOption.closest('[data-slot="scroll-area-viewport"]');
        if (!(viewport instanceof HTMLElement)) {
            throw new Error("The story did not render the model list viewport");
        }

        viewport.scrollTop = viewport.scrollHeight;
        const scrolledTop = viewport.scrollTop;
        await expect(scrolledTop).toBeGreaterThan(0);

        // Hovering a row clipped out of view moves the highlight and must not move the list.
        await fireEvent.mouseMove(firstOption);
        await expect(firstOption).toHaveAttribute("data-lit", "true");
        await expect(viewport.scrollTop).toBe(scrolledTop);

        // The keyboard cursor still reveals its row.
        const search = screen.getByRole("combobox", { name: "Search models" });
        search.focus();
        await userEvent.keyboard("{ArrowDown}");
        await waitFor(() => expect(viewport.scrollTop).toBeLessThan(scrolledTop));

        // The story ends with the popover closed, so the a11y scan does not see an unnamed dialog.
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    },
};
