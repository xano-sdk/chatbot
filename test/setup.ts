/**
 * Global test hygiene.
 *
 * Much shorter than `@xano-sdk/auth`'s equivalent, and the difference is the point:
 * that package has a process-wide `authenticationGroup` singleton whose
 * `canonical` and `history` leak between tests, so its setup has to unset both.
 * Every def here is minted per `createChatbot` call, so the only shared state left
 * is core's own lock overrides.
 */
import { afterEach } from "vitest";
import { resetLockOverrides } from "@xano/sdk";

afterEach(() => {
  resetLockOverrides();
});
