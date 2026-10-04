/**
 * The `conversation` table — one chat thread, owned by an authenticated user, a
 * guest session, or (when both families are enabled) either.
 *
 * A factory rather than a module singleton because `user_id` is an
 * `f.tableRef` at the caller's chosen auth table, and core resolves that
 * reference's guid eagerly at column-construction time. See `src/options.ts`.
 *
 * `id` / `created_at` and the `primary(id)` / `btree(created_at desc)` indexes
 * are the engine's system defaults — auto-injected, not declared here.
 */
import { table, f } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";

/** Build the `conversation` def for the given resolved options. */
export function conversationTable(opts: ResolvedOptions) {
  return table({
    name: opts.names.conversation,
    description:
      "A single chat thread. Owned by a user (authenticated) and/or reachable with a session token (guest).",
    auth: false,
    // Pinned rather than inherited: a table with no explicit `useXdo` takes the
    // CONSUMER workspace's `use_xdo` at export, which would silently change this
    // table's storage mode — and therefore its emitted bytes — depending on who
    // installed it. `true` keeps the non-key columns in the internal `xdo` JSON
    // column (and auto-prepends the engine's `gin(xdo)` index in canonical order).
    useXdo: true,
    tags: opts.tags,
    schema: {
      // Present only when the authenticated family is on. A guest-only install
      // has no auth table to point at, and a nullable FK to nothing is worse
      // than no column: it would still emit an `@` method carrying a guid that
      // resolves to no registered table, which fails the export.
      ...(opts.authenticated
        ? {
            user_id: f.tableRef(opts.authTable as NonNullable<ResolvedOptions["authTable"]>, {
              type: opts.userIdType,
              // Nullable exactly when guests are also enabled: a guest thread has
              // no owner until it is claimed. With guests off, every conversation
              // is created by an authenticated endpoint that always fills this in,
              // so the tighter column is the honest one.
              ...(opts.guest ? { nullable: true } : {}),
              description: "The user this conversation belongs to. Null until a guest thread is claimed.",
            }),
          }
        : {}),
      // Present only when guests are enabled. This is a BEARER CAPABILITY: it is
      // the whole of a guest's authorization, so it is minted by
      // `security.create_uuid` (not derived from anything guessable) and its
      // column is `internal` so a stray `db.get` without an explicit `output`
      // list cannot leak another thread's token into a response.
      ...(opts.guest
        ? {
            session_token: f.text({
              access: "internal",
              description:
                "Opaque bearer capability for guest access to this thread. Treat it like a password.",
            }),
          }
        : {}),
      title: f.text({
        methods: ["trim"],
        description: "Human-readable thread title. Seeded from the first user message.",
      }),
      // Maintained by the reply function so a conversation list can sort by
      // recency without joining the message table.
      last_message_at: f.timestamp({
        nullable: true,
        description: "When the most recent message was appended. Null until the first send.",
      }),
    },
    index: [
      // The authenticated list endpoint's access path: every user's threads,
      // newest first. Without it that endpoint is a full scan of every
      // conversation in the workspace.
      ...(opts.authenticated
        ? [{ type: "btree" as const, fields: [{ name: "user_id", op: "asc" as const }] }]
        : []),
      // Unique, not merely indexed: a guest's entire authorization is "I hold
      // this token", so two rows sharing one would make a single token address
      // two threads. Uniqueness is what makes the lookup unambiguous.
      ...(opts.guest
        ? [{ type: "btree|unique" as const, fields: [{ name: "session_token", op: "asc" as const }] }]
        : []),
    ],
  });
}

/** The `conversation` def type, for consumers naming it explicitly. */
export type ConversationTable = ReturnType<typeof conversationTable>;

/**
 * A `conversation` row.
 *
 * Declared rather than `InferRow`-derived off a factory result, because which
 * columns exist depends on the options passed — an inferred type would be
 * per-call and unnameable. `user_id` and `session_token` are therefore optional
 * here: present in the store exactly when their family is enabled.
 */
export interface Conversation {
  id: number;
  created_at: number;
  /** Present when the authenticated family is enabled; null on an unclaimed guest thread. */
  user_id?: number | string | null;
  /** Present when the guest family is enabled. `internal` access — never returned by this package's endpoints. */
  session_token?: string;
  title: string;
  last_message_at: number | null;
}

/**
 * The columns this package's endpoints return for a conversation — the single
 * source of truth for their `output` lists and for {@link PublicConversation},
 * so the two cannot drift.
 *
 * `session_token` is deliberately absent: it is the guest bearer capability and
 * is handed back exactly once, by the create endpoint that mints it, from that
 * statement's own binding — never re-read and re-served afterwards.
 */
export const PUBLIC_CONVERSATION_FIELDS = [
  "id",
  "created_at",
  "title",
  "last_message_at",
] as const satisfies readonly (keyof Conversation)[];

/** The conversation projection this package's endpoints hand back. */
export type PublicConversation = Pick<Conversation, (typeof PUBLIC_CONVERSATION_FIELDS)[number]>;
