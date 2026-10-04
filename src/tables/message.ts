/**
 * The `conversation_message` table — one turn in a thread.
 *
 * Two column choices here are load-bearing rather than cosmetic, and both come
 * from behaviour verified against a live Xano instance (see AGENTS.md). The
 * engine decodes the agent's rendered `messages` template into real LLM message
 * roles, and it is strict about what it will decode:
 *
 *   - a role outside the provider's set (`"librarian"`) → `ERROR_FATAL`,
 *     "Unable to successfully run Agent"
 *   - an empty `content` string → NOT an error; the model receives a blank turn
 *     and confabulates. The observed reply invented an entire fictional prior
 *     exchange about correcting the word "mispelled".
 *
 * Both failures are produced by the *stored row*, one message later, in a
 * different endpoint from the one that wrote it. So the guard belongs in the
 * schema: `role` is an enum and `content` is required with a `min:1` length
 * method, which makes both states unstorable rather than merely unlikely.
 */
import { table, f, type InferRow } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";
import type { ConversationTable } from "./conversation.js";

/**
 * The roles the engine accepts in a decoded `messages` array. Exported because
 * it is simultaneously the column's enum, the {@link MessageRole} type, and the
 * set the reply function is allowed to write — one reviewed list, not three.
 */
export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;

/** A stored message's role. */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Build the `conversation_message` def for the given resolved options. */
export function messageTable(opts: ResolvedOptions, conversation: ConversationTable) {
  return table({
    name: opts.names.message,
    description: "One turn in a conversation. Replayed to the agent as an LLM message.",
    auth: false,
    // Pinned for the same reason as `conversation` — see that module.
    useXdo: true,
    tags: opts.tags,
    schema: {
      conversation_id: f.tableRef(conversation, {
        required: true,
        description: "The thread this message belongs to.",
      }),
      // An enum, NOT free text. An unrecognized role is a fatal agent error on
      // the NEXT send, so the database is the right place to make it impossible.
      role: f.enum(MESSAGE_ROLES, {
        required: true,
        description: "Who produced this turn. The engine rejects any other value when replaying it.",
      }),
      // `min:1` is the guard against the confabulation described in the header:
      // an empty turn does not fail loudly, it produces a plausible fabrication.
      content: f.text({
        required: true,
        methods: ["min:1"],
        description: "The message text. Must be non-empty — a blank turn makes the model confabulate.",
      }),
    },
    index: [
      // The access path for both the transcript endpoint and the reply
      // function's history window: one thread's turns in order. A composite with
      // `created_at` so the sort is served by the index rather than a filesort.
      {
        type: "btree",
        fields: [
          { name: "conversation_id", op: "asc" },
          { name: "created_at", op: "asc" },
        ],
      },
    ],
  });
}

/** The `conversation_message` def type. */
export type MessageTable = ReturnType<typeof messageTable>;

/** A `conversation_message` row. */
export type Message = InferRow<ReturnType<typeof messageTable>>;

/**
 * The columns this package's endpoints return for a message — the single source
 * of truth for their `output` lists and for {@link PublicMessage}.
 */
export const PUBLIC_MESSAGE_FIELDS = [
  "id",
  "created_at",
  "conversation_id",
  "role",
  "content",
] as const;

/** The message projection this package's endpoints hand back. */
export interface PublicMessage {
  id: number;
  created_at: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
}
