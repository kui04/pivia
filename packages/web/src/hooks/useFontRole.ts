import { useEffect } from "react";

import { ensureFontRole, type FontRole, isFontRoleReady } from "@/lib";

/**
 * Requests the active web font for `role` after mount so unused font families stay off
 * the initial bundle and network critical path.
 */
export function useFontRole(role: FontRole): void {
    useEffect(() => {
        if (isFontRoleReady(role)) {
            return;
        }
        void ensureFontRole(role);
    }, [role]);
}
