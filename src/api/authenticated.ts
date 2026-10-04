/**
 * The token-authenticated endpoint family (`chat/*`), scoped by `auth("id")`.
 *
 * One module for the whole family rather than `@xano-sdk/auth`'s one-def-per-module
 * layout: every def here is a factory over the same four handles, so five
 * separate modules would be five copies of an identical five-parameter signature
 * and nothing else. The family shares one authorization idiom, and keeping it in
 * one file is what lets that idiom be stated once (see `ownershipGuard`).
 *
 * ## Why route names are not RESTful pairs
 *
 * The SDK composes a query's identity from `(api group, verb, name)`, so a verb
 * pair on one name is legal. Each endpoint still has a distinct *name*: identity
 * belongs to the consumer's `xano.lock`, so a rename would move every consumer's
 * identity, and this package must not pin explicit guids. `create`/`send` read as
 * Xano-idiomatic anyway — the same shape as
 * `auth/signup` and `auth/login`.
 */
import { query, input, s, c, inp, ref, expr, col, auth, withFilters, fl, statements, setVar } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";
import type { ConversationTable } from "../tables/conversation.js";
import { PUBLIC_CONVERSATION_FIELDS } from "../tables/conversation.js";
import type { MessageTable, PublicMessage } from "../tables/message.js";
import { PUBLIC_MESSAGE_FIELDS } from "../tables/message.js";
import type { GenerateReplyFn } from "../functions/generate-reply.js";
import type { ChatbotGroup } from "./group.js";
import type { ChatReply } from "./types.js";
import { TITLE_LENGTH } from "../functions/generate-reply.js";

/**
 * Prove the caller owns the thread, or 404.
 *
 * Two properties worth stating, because both are easy to lose in a refactor:
 *
 * - **`safe: true` on the ref is load-bearing.** `db.get` binds `null` on a miss,
 *   and an unguarded dotted ref through a null base is a runtime
 *   "Unable to locate var" — an HTTP 500 on the ordinary "wrong id" path. With
 *   `safe`, a miss drills to null, null fails the comparison, and the
 *   precondition reports it properly.
 * - **A missing thread and someone else's thread return the SAME `notfound`.**
 *   Deliberate: an `accessdenied` on a thread that exists but isn't yours
 *   confirms its existence to anyone enumerating ids.
 * - **`statements(...)` is load-bearing, not decoration.** A helper returning a
 *   plain `Statement[]` widens the stack the moment it is spread: the tuple type
 *   collapses, every `as`/`ref()` in the consuming stack — *including ones
 *   declared after the spread* — resolves to `unknown`, and the query's response
 *   infers as `StackTupleWidened`. Nothing fails here; it surfaces in a
 *   consumer's frontend typecheck. `statements()` is a const-generic identity
 *   function whose tuple survives the spread.
 */
const ownershipGuard = (conversation: ConversationTable) =>
  statements(
    s.db.get({
      table: conversation,
      fieldName: "id",
      fieldValue: inp("conversation_id"),
      output: ["id", "user_id"],
      as: "conversation",
    }),
    s.precondition({
      expr: expr(ref("conversation.user_id", { safe: true }), "=", auth("id")),
      error_type: "notfound",
      error: c.text("Conversation not found."),
    }),
  );

export function authenticatedQueries(
  opts: ResolvedOptions,
  group: ChatbotGroup,
  conversation: ConversationTable,
  message: MessageTable,
  replyFn: GenerateReplyFn,
) {
  const base = { apiGroup: group, auth: opts.authTable, tags: opts.tags } as const;
  // Every route name is built from the prefix, so a second install in the same
  // workspace can take its own and avoid the guid collision described above.
  const p = opts.routePrefix;

  /**
   * Mint a token even though this thread already has an owner and no guest
   * endpoint will ever be told it.
   *
   * Omitting it was a bug, caught on a live instance. `session_token` carries a
   * UNIQUE index (a guest's whole authorization is "I hold this token", so two
   * rows sharing one would make a single token address two threads), and an
   * omitted column takes its type default on `db.add` — `""` for text. So the
   * FIRST authenticated create succeeded and the SECOND died on
   * `duplicate key value violates unique constraint`.
   *
   * The unique index was also the only thing preventing something worse: with
   * every authenticated row sharing `""`, a guest request carrying an empty
   * token would match an authenticated user's thread. Filling the column removes
   * both the collision and the sentinel value an attacker would aim at. The
   * guest guard's `user_id IS NULL` check is the second, independent barrier —
   * see `api/guest.ts`.
   */
  const mintSessionToken = s.security.create_uuid({ as: "session_token" });

  /** The row write, with the token column present only when guests are enabled. */
  const addConversation = (withToken: boolean) =>
    s.db.add({
      table: conversation,
      as: "conversation",
      output: PUBLIC_CONVERSATION_FIELDS,
      data: [
        { name: "created_at", value: c.text("now") },
        { name: "user_id", value: auth("id") },
        // Truncated to the same length the reply function's auto-title uses, so
        // a caller-supplied title and a generated one cannot differ in bound.
        { name: "title", value: withFilters(inp("title"), fl.substr(c.int(0), c.int(TITLE_LENGTH))) },
        // Never returned: absent from PUBLIC_CONVERSATION_FIELDS, and the column
        // is `internal`.
        ...(withToken ? [{ name: "session_token", value: ref("session_token") }] : []),
      ],
    });

  /** POST `chat/conversations/create` — open a new thread owned by the caller. */
  const createConversation = query({
    ...base,
    name: `${p}/conversations/create`,
    verb: "POST",
    description: "Create a new conversation owned by the authenticated user",
    input: {
      title: input.text({
        methods: ["trim"],
        description: "Optional thread title. Left blank, the first message's opening words become the title.",
      }),
    },
    // Two `statements(...)` branches rather than one array with a
    // `...(opts.guest ? [x] : [])` spread. That spread is not a fixed tuple, so
    // it widens the stack and resolves this endpoint's `ref("conversation")` —
    // and therefore its whole response type — to `unknown` in every consumer.
    // Same trap as a `Statement[]` helper; see `ownershipGuard` above.
    //
    // The `data` array below keeps its conditional spread: it is a statement
    // FIELD, not the stack, so no `as`/`ref()` inference depends on its tuple.
    stack: opts.guest
      ? statements(mintSessionToken, addConversation(true))
      : statements(addConversation(false)),
    response: ref("conversation"),
  });

  /** GET `chat/conversations` — the caller's threads, most recently active first. */
  const listConversations = query({
    ...base,
    name: `${p}/conversations`,
    verb: "GET",
    description: "List the authenticated user's conversations, most recently active first",
    input: {},
    stack: [
      s.db.query({
        table: conversation,
        where: expr(col("user_id"), "=", auth("id")),
        output: PUBLIC_CONVERSATION_FIELDS,
        // `last_message_at` is null until the first send, so a brand-new empty
        // thread sorts last under `desc`. `id desc` is the tiebreak that keeps it
        // visible at a stable position rather than shuffling between requests.
        sort: [
          { sortBy: "last_message_at", dir: "desc" },
          { sortBy: "id", dir: "desc" },
        ],
        paging: { per_page: opts.listLimit, metadata: false },
        as: "conversations",
      }),
    ],
    response: ref("conversations"),
  });

  /** GET `chat/conversations/{conversation_id}/messages` — the transcript. */
  const listMessages = query({
    ...base,
    name: `${p}/conversations/{conversation_id}/messages`,
    verb: "GET",
    description: "Read a conversation's transcript, oldest message first",
    input: { conversation_id: input.int({ required: true }) },
    stack: [
      ...ownershipGuard(conversation),
      // Newest-N in the database, then reversed for display — the same shape the
      // reply function uses, and for the same reason: a capped read. A thread
      // longer than the cap loses its OLDEST messages from this response, which
      // is the right end to drop for a chat UI that renders from the bottom.
      s.db.query({
        table: message,
        where: expr(col("conversation_id"), "=", inp("conversation_id")),
        output: PUBLIC_MESSAGE_FIELDS,
        sort: [
          { sortBy: "created_at", dir: "desc" },
          { sortBy: "id", dir: "desc" },
        ],
        paging: { per_page: opts.transcriptLimit, metadata: false },
        as: "recent",
      }),
      s.set_var("messages", withFilters(ref("recent"), fl.reverse())),
    ],
    response: ref("messages"),
    // Declared, not derived — the same exception `sendMessage` makes, for the
    // same reason. The response is a `set_var` bound to an UNTYPED filter
    // (`fl.reverse` is `typed: false`, result `<T>[]`), and core's static walk
    // resolves both a `set_var` output and an untyped filter's result to
    // `unknown`. Without this the transcript endpoint hands every consumer
    // `unknown` and the frontend loses the projection entirely.
    //
    // The shape is not a guess: `output: PUBLIC_MESSAGE_FIELDS` is what the
    // db.query above projects, and `PublicMessage` is derived from that same
    // array — so editing the array still moves this type.
    responseShape: [] as PublicMessage[],
  });


  /**
   * Per-user ceiling on the one endpoint that costs money.
   *
   * Keyed on `auth("id")` — a real identity here, unlike the guest family (see
   * `api/guest.ts`). Placed FIRST in the stack, before the ownership guard, so a
   * caller probing conversation ids burns their own budget rather than ours.
   *
   * Returns `statements()` either way so the stack keeps its tuple type — a bare
   * `[]` spread would widen it and destroy every response type in this family.
   */
  const sendRateLimit = opts.rateLimit
    ? statements(
        s.redis.ratelimit({
          key: withFilters(c.text(`${p}:send:`), fl.concat(auth("id"))),
          max: c.int(opts.rateLimit.max),
          ttl: c.int(opts.rateLimit.ttl),
          error: c.text(opts.rateLimit.error),
        }),
      )
    : statements();

  /** POST `chat/conversations/{conversation_id}/send` — say something, get a reply. */
  const sendMessage = query({
    ...base,
    name: `${p}/conversations/{conversation_id}/send`,
    verb: "POST",
    description: "Append a message to the conversation and return the agent's reply",
    input: {
      conversation_id: input.int({ required: true }),
      // `trim` is load-bearing, not cosmetic. Without it a whitespace-only
      // message ("   ") passes `required` (length 3) AND passes the reply
      // function's `content != ""` guard, so a blank turn reaches the model,
      // which confabulates — verified live: it replied "I can't respond to an
      // empty message" and BOTH turns were written to the transcript, poisoning
      // every later turn's context. Trimmed, "   " becomes "" and the engine
      // refuses it up front as a missing param, like any other empty content.
      content: input.text({
        required: false,
        methods: ["trim"],
        description: "The user's message. Must be non-empty after trimming.",
      }),
      message: input.text({
        required: false,
        methods: ["trim"],
        description: "Alias for `content`.",
      }),
      prompt: input.text({
        required: false,
        methods: ["trim"],
        description: "Alias for `content`.",
      }),
    },
    stack: [
      ...sendRateLimit,
      ...ownershipGuard(conversation),
      setVar(
        "resolved_turn_content",
        withFilters(inp("content"), [
          fl.first_notempty(inp("message")),
          fl.first_notempty(inp("prompt")),
        ]),
      ),
      s.precondition({
        expr: expr(ref("resolved_turn_content"), "!=", c.text("")),
        error_type: "badrequest",
        error: c.text("send: non-empty message content must be provided via `content`, `message`, or `prompt`."),
      }),
      // Everything past the guard is shared with the guest family — see
      // `functions/generate-reply.ts`.
      s.function.run({
        fn: replyFn,
        as: "reply",
        input: { conversation_id: inp("conversation_id"), content: ref("resolved_turn_content") },
      }),
    ],
    response: ref("reply"),
    // Declared, not derived: `reply` is the agent run's `.result`, which core
    // resolves to `unknown` because the agent carries no structured-output
    // schema. See `api/types.ts`.
    responseShape: {} as ChatReply,
  });

  /** DELETE `chat/conversations/{conversation_id}` — remove a thread and its turns. */
  const deleteConversation = query({
    ...base,
    name: `${p}/conversations/{conversation_id}`,
    verb: "DELETE",
    description: "Delete a conversation and every message in it",
    input: { conversation_id: input.int({ required: true }) },
    stack: [
      ...ownershipGuard(conversation),
      // Messages first. The other order would leave orphaned message rows behind
      // if the second delete failed, and nothing would ever collect them — the FK
      // is a reference, not a cascade.
      s.db.bulk.delete({
        table: message,
        where: expr(col("conversation_id"), "=", inp("conversation_id")),
      }),
      s.db.del({ table: conversation, fieldName: "id", fieldValue: inp("conversation_id") }),
    ],
    // No body. The thread is gone; there is nothing truthful to return about it.
    response: c.null(),
  });

  /**
   * POST `chat/conversations/{conversation_id}/claim` — adopt a guest thread.
   *
   * Only exists when BOTH families are on, because it is the bridge between them:
   * it is authenticated (so it knows who is claiming) and it proves the caller
   * held the guest capability (so it knows they were the one chatting).
   */
  const claimConversation = opts.guest
    ? query({
        ...base,
        name: `${p}/conversations/{conversation_id}/claim`,
        verb: "POST",
        description: "Attach an unclaimed guest conversation to the authenticated user",
        input: {
          conversation_id: input.int({ required: true }),
          session_token: input.text({
            required: true,
            description: "The guest session token the thread was created with.",
          }),
        },
        stack: [
          s.db.get({
            table: conversation,
            fieldName: "id",
            fieldValue: inp("conversation_id"),
            // `session_token` is an `internal` column, so it must be named
            // explicitly — an `output` list overrides column visibility. It stays
            // inside this stack and is never returned.
            output: ["id", "user_id", "session_token"],
            as: "conversation",
          }),
          // The token must match. Same `notfound` as everywhere else, so a wrong
          // token cannot be distinguished from a wrong id.
          s.precondition({
            expr: expr(ref("conversation.session_token", { safe: true }), "=", inp("session_token")),
            error_type: "notfound",
            error: c.text("Conversation not found."),
          }),
          // And it must be UNCLAIMED. Without this, anyone who ever held the guest
          // token could re-claim the thread away from its current owner — the
          // token outlives the guest phase, so this is what ends its authority.
          s.precondition({
            expr: expr(ref("conversation.user_id", { safe: true }), "=", c.null()),
            error_type: "accessdenied",
            error: c.text("This conversation has already been claimed."),
          }),
          s.db.edit({
            table: conversation,
            fieldName: "id",
            fieldValue: inp("conversation_id"),
            output: PUBLIC_CONVERSATION_FIELDS,
            data: [{ name: "user_id", value: auth("id") }],
            as: "claimed",
          }),
        ],
        response: ref("claimed"),
      })
    : undefined;

  return {
    createConversation,
    listConversations,
    listMessages,
    sendMessage,
    deleteConversation,
    /** `undefined` unless the guest family is also enabled — see above. */
    claimConversation,
    /**
     * Every def above that actually exists, ready to register. Built as one array
     * literal rather than a `push`, so the element type is the union of the
     * handles rather than the first one's — each `query()` handle carries its own
     * literal `name` in its type, so a mutable array would fix that type to
     * whichever def happened to be first.
     */
    all: [
      createConversation,
      listConversations,
      listMessages,
      sendMessage,
      deleteConversation,
      ...(claimConversation ? [claimConversation] : []),
    ],
  };
}
