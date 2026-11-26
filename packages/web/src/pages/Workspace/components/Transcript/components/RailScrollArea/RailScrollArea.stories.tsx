import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { expect, userEvent, waitFor } from "storybook/test";

import { requireElement, requireViewport } from "@/storybook/dom";
import storyFrame from "@/storybook/storyFrame.module.css";

import { RailScrollArea } from "./RailScrollArea";

function ParagraphList({ count }: { readonly count: number }): ReactElement {
    return (
        <div>
            {Array.from({ length: count }, (_, index) => (
                <p key={index}>
                    Row {index + 1}: verifying rail thumb sizing, drag scrolling, wheel chaining, and focus clearance.
                </p>
            ))}
        </div>
    );
}

const meta = {
    title: "Pages/Workspace/Transcript/RailScrollArea",
    component: RailScrollArea,
    args: {
        label: "Rail scroll sample",
        enabled: true,
        maxHeight: "md",
        indent: "body",
        children: <ParagraphList count={2} />,
    },
    argTypes: {
        children: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof RailScrollArea>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ShortContentHidesThumb: Story = {
    play: async ({ canvasElement }) => {
        const rail = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-scrollbar']"),
            "the rail track",
        );
        const thumb = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-thumb']"),
            "the rail thumb",
        );

        await expect(rail).not.toHaveAttribute("data-overflowing");
        await expect(thumb).not.toBeVisible();
    },
};

export const FixedThumbInteractions: Story = {
    args: {
        children: <ParagraphList count={18} />,
    },
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the rail viewport");
        const rail = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-scrollbar']"),
            "the rail track",
        );
        const thumb = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-thumb']"),
            "the rail thumb",
        );

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(rail).toHaveAttribute("data-overflowing", "true");
            await expect(thumb).toBeVisible();
        });

        await expect(thumb.getBoundingClientRect().height).toBeCloseTo(24, 0);

        // Click near the bottom of the rail track to jump down.
        const railRect = rail.getBoundingClientRect();
        rail.dispatchEvent(
            new PointerEvent("pointerdown", {
                button: 0,
                buttons: 1,
                pointerId: 1,
                clientX: railRect.left + railRect.width / 2,
                clientY: railRect.bottom - 12,
                bubbles: true,
            }),
        );
        rail.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
        await waitFor(async () => {
            await expect(viewport.scrollTop).toBeGreaterThan(50);
            await expect(thumb.getBoundingClientRect().top).toBeGreaterThan(railRect.top + 100);
        });

        // Drag the thumb back toward the top using real browser pointer input.
        const thumbRect = thumb.getBoundingClientRect();
        const beforeDragTop = viewport.scrollTop;
        await userEvent.pointer([
            {
                keys: "[MouseLeft>]",
                target: thumb,
                coords: { x: thumbRect.left + thumbRect.width / 2, y: thumbRect.top + thumbRect.height / 2 },
            },
            {
                coords: { x: thumbRect.left + thumbRect.width / 2, y: railRect.top + 12 },
            },
            { keys: "[/MouseLeft]" },
        ]);
        await waitFor(async () => {
            await expect(viewport.scrollTop).toBeLessThan(beforeDragTop);
        });

        // Wheel over the rail scrolls the viewport when inside bounds and leaves edges unconsumed.
        const beforeWheelTop = viewport.scrollTop;
        const midWheel = new WheelEvent("wheel", { deltaY: 60, cancelable: true, bubbles: true });
        rail.dispatchEvent(midWheel);
        await expect(midWheel.defaultPrevented).toBe(true);
        await expect(viewport.scrollTop).toBeGreaterThan(beforeWheelTop);

        viewport.scrollTop = 0;
        const topEdgeWheel = new WheelEvent("wheel", { deltaY: -60, cancelable: true, bubbles: true });
        rail.dispatchEvent(topEdgeWheel);
        await expect(topEdgeWheel.defaultPrevented).toBe(false);
    },
};
