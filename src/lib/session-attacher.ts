import { createMiddleware } from "@tanstack/react-start";

/**
 * Pocket ID sessions are stored in an HttpOnly cookie, which the browser sends
 * automatically on same-origin server-function calls. No header injection needed.
 */
export const attachSessionAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  return next({ headers: {} });
});
