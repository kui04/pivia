import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Button } from "../Button";
import { Field } from "../Field";
import { Fieldset } from "../Fieldset";
import { Input } from "../Input";
import { Select } from "../Select";

import storyFrame from "@/storybook/storyFrame.module.css";
import { Form } from "./Form";

const onFormSubmit = fn();

const visibilityOptions = [
    { value: "private", label: "Private" },
    { value: "team", label: "Team" },
];

function FormDemo() {
    return (
        <Form onFormSubmit={onFormSubmit}>
            <Fieldset legend="Project details">
                <Field label="Name" name="name" description="Shown in the workspace.">
                    <Input placeholder="e.g. Atlas" required />
                </Field>
                <Field label="Visibility" name="visibility" nativeLabel={false}>
                    <Select options={visibilityOptions} defaultValue="private" />
                </Field>
            </Fieldset>
            <Button type="submit" className={storyFrame.alignStart}>
                Save
            </Button>
        </Form>
    );
}

const meta = {
    title: "Components/Form",
    component: Form,
    args: {
        onFormSubmit,
    },
    argTypes: {
        onFormSubmit: { control: false },
    },
} satisfies Meta<typeof Form>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SubmitValidation: Story = {
    render: () => <FormDemo />,
    play: async ({ canvasElement }) => {
        onFormSubmit.mockClear();
        const canvas = within(canvasElement);
        const name = canvas.getByLabelText("Name");
        const submit = canvas.getByRole("button", { name: "Save" });

        await userEvent.click(submit);

        await waitFor(() => expect(canvas.getByRole("alert")).toBeVisible());
        await expect(name).toHaveAttribute("aria-invalid", "true");
        await expect(name).toHaveFocus();
        await expect(canvas.getByText("Shown in the workspace.")).not.toBeVisible();
        await expect(onFormSubmit).not.toHaveBeenCalled();

        await userEvent.type(name, "Atlas");
        await userEvent.click(submit);

        await expect(onFormSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Atlas", visibility: "private" }),
            expect.anything(),
        );
    },
};
