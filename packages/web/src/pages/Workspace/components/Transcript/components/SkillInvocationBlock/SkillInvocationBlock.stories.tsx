import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { TranscriptSkillItem } from "@/stores/session";

import { TranscriptFrame } from "@/storybook/frames";
import { SkillInvocationBlock } from "./SkillInvocationBlock";

const skillItem: TranscriptSkillItem = {
    kind: "skill",
    id: "skill-tydd",
    name: "tydd",
    location: "/home/kui04/.pi/agent/skills/tydd/SKILL.md",
    content: [
        "References are relative to /home/kui04/.pi/agent/skills/tydd.",
        "",
        "## Role",
        "",
        "Act as a senior software architect practicing Type-Driven Development.",
        "",
        "- Model illegal states with closed unions.",
        "- Parse untrusted data once at the boundary.",
    ].join("\n"),
};

const meta = {
    title: "Pages/Workspace/Transcript/SkillInvocationBlock",
    component: SkillInvocationBlock,
    args: {
        item: skillItem,
        onOpenLink: fn(),
    },
    argTypes: {
        item: { control: false },
        onOpenLink: { control: false },
    },
    decorators: [TranscriptFrame],
} satisfies Meta<typeof SkillInvocationBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CollapsedInvocation: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "[skill] tydd" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText(/senior software architect/)).toBeVisible();
        await expect(canvas.getByText("/home/kui04/.pi/agent/skills/tydd/SKILL.md")).toBeVisible();
        await expect(canvas.getByRole("group", { name: "tydd skill details" })).toBeVisible();
    },
};
