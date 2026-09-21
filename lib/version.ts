/**
 * Which build is running. Values are injected by next.config.mjs at build time.
 *
 * Shown in the home-page footer so that after an update you can see at a glance that
 * the new code actually loaded — a stale browser tab or a dev server that never
 * restarted otherwise looks exactly like "the update didn't work".
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
export const BUILD_NUMBER = process.env.NEXT_PUBLIC_BUILD_NUMBER ?? "0";
export const COMMIT = process.env.NEXT_PUBLIC_COMMIT ?? "unknown";

export function versionLabel(): string {
  return `v${APP_VERSION} · build ${BUILD_NUMBER} · ${COMMIT}`;
}
