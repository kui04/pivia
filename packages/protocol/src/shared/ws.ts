/** Standard WebSocket close codes shared across every server and browser socket route. */
export const WS_CLOSE_CODE = {
    normal: 1000,
    goingAway: 1001,
    internalError: 1011,
    slowConsumer: 1013,
} as const;

/** One known standard WebSocket close code used by Pivia routes. */
export type WsCloseCode = (typeof WS_CLOSE_CODE)[keyof typeof WS_CLOSE_CODE];
