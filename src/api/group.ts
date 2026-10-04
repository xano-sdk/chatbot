/**
 * The `Chatbot` API group — the container both endpoint families live in.
 *
 * A factory, like everything else here, so `canonical` and `history` are plain
 * per-call values. `@xano-sdk/auth` has to guard those two settings against
 * disagreement between calls because its group is a process-wide module
 * singleton; a fresh def per call cannot be retargeted by a later one, so there
 * is nothing to guard.
 *
 * Request history defaults **off** (`resolveOptions`), against the engine's
 * inherit-on. Xano's request history records the request body, and on this
 * package that body carries the user's message text — and, on the guest family,
 * the `session_token` that is the entire authorization for a thread. Neither
 * belongs in the workspace's history store by default.
 */
import { apiGroup } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";

export function chatbotGroup(opts: ResolvedOptions) {
  return apiGroup({
    name: opts.names.apiGroup,
    description:
      "Conversational AI endpoints: create and list conversations, read a transcript, and send a message to the agent.",
    tags: opts.tags,
    // Only set when pinned — leaving it undefined is what defers identity to the
    // consumer's `xano.lock` (or to a random segment assigned at import).
    ...(opts.canonical !== undefined ? { canonical: opts.canonical } : {}),
    history: opts.history,
  });
}

/** The API group def type. */
export type ChatbotGroup = ReturnType<typeof chatbotGroup>;
