import { createBrowserRouter, Navigate } from "react-router";

import { AppLayout } from "@/pages/AppLayout";
import { RouteError } from "@/pages/RouteError";
import { WorkspaceLayout } from "@/pages/Workspace";

/**
 * The route table.
 *
 * A data router must not live in React state, so this module creates the one instance at load and
 * `main.tsx` only passes it to `RouterProvider`. The root error boundary catches render errors,
 * rejected route imports and unknown URLs, so a failure never leaves a blank page.
 */
export const router = createBrowserRouter([
    {
        path: "/",
        Component: AppLayout,
        errorElement: <RouteError />,
        children: [
            {
                index: true,
                element: <Navigate to="/workspace" replace />,
            },
            {
                // WorkspaceLayout renders the split-pane tree internally without an <Outlet />; the
                // empty child routes keep /workspace and /workspace/:sessionId matched to it so
                // useParams() receives `sessionId`.
                path: "workspace",
                Component: WorkspaceLayout,
                children: [
                    {
                        index: true,
                        element: null,
                    },
                    {
                        path: ":sessionId",
                        element: null,
                    },
                ],
            },
        ],
    },
]);
