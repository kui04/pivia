import type { Meta, StoryObj } from "@storybook/react-vite";
import { createMemoryRouter, Outlet, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { expect, within } from "storybook/test";

import { RouteError } from "./RouteError";

const RENDER_ERROR = new Error("The workspace bundle could not be loaded.");

function routes(throws: boolean): RouteObject[] {
    return [
        {
            path: "/",
            element: <Outlet />,
            errorElement: <RouteError />,
            children: [
                {
                    index: true,
                    element: <p>Workspace</p>,
                    ...(throws
                        ? {
                              loader: () => {
                                  throw RENDER_ERROR;
                              },
                          }
                        : {}),
                },
            ],
        },
    ];
}

const notFoundRouter = createMemoryRouter(routes(false), { initialEntries: ["/missing"] });
const renderErrorRouter = createMemoryRouter(routes(true), { initialEntries: ["/"] });

const meta = {
    title: "Pages/RouteError",
    component: RouteError,
} satisfies Meta<typeof RouteError>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PageNotFound: Story = {
    render: () => <RouterProvider router={notFoundRouter} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const link = canvas.getByRole("link", { name: "Back to the workspace" });

        await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
        await expect(canvas.getByText("404 Not Found")).toBeVisible();
        await expect(link).toHaveAttribute("href", "/workspace");
    },
};

export const RenderError: Story = {
    render: () => <RouterProvider router={renderErrorRouter} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong");
        await expect(canvas.getByText("The workspace bundle could not be loaded.")).toBeVisible();
        await expect(canvas.getByRole("link", { name: "Back to the workspace" })).toBeVisible();
    },
};
