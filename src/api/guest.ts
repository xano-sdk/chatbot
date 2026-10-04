/**
 * The public guest endpoint family (`chat/guest/*`), scoped by an unguessable
 * `session_token` instead of a login.
 *
 * ## Why this is a separate family and not a mode
 *
 * A Xano endpoint's `auth` is binary — there is no optional-auth flag on a query
 * def — and the two boundaries were verified against a live instance:
 *
 *   | endpoint  | request              | result                     |
 *   | --------- | -------------------- | -------------------------- |
 *   | `auth` set | no token            | 401 Unauthorized           |
 *   | public     | no token            | `auth()` → ACCESS_DENIED   |
 *   | public     | **valid** token     | `auth()` → ACCESS_DENIED   |
 *
 * The third row is the decisive one: referencing `auth()` in a public stack
 * raises rather than resolving to null, so a public endpoint cannot opportunistically
 * read a token even when the caller supplies one. One endpoint therefore cannot
 * serve both callers, and the honest implementation is two families over shared
 * tables — each with exactly one authorization rule.
 *
 * ## The security property, stated plainly
 *
 * A guest thread is protected by a **bearer capability**, not an identity. Whoever
 * holds `session_token` can read and continue that conversation. It is minted by
 * `security.create_uuid` (not derived from anything guessable), stored in an
 * `internal` column, and returned exactly once — by the create endpoint, from that
 * statement's own binding. No endpoint ever reads it back out to a caller.
 *
 * That still means: it travels in a request body on every guest call, so it lands
 * in any intermediary that logs bodies (which is why this package defaults request
 * history OFF), and a client that persists it in `localStorage` has persisted a
 * credential. Claiming a thread (`chat/conversations/{id}/claim`) ends the token's
 * authority by setting an owner, after which the guest endpoints reject it.
 */
import { query, input, s, c, inp, ref, expr, col, withFilters, fl, statements, sys, setVar } from "@xano/sdk";
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
 * Prove the caller holds this thread's capability, or 404.
 *
 * Structurally the authenticated family's `ownershipGuard` with the comparison
 * swapped — token instead of `auth("id")` — plus one extra precondition the
 * authenticated side has no need for: the thread must still be **unclaimed**.
 * Once a user owns it, the token that created it must stop working, or logging in
 * would leave a second, weaker credential permanently valid against a thread the
 * user now considers theirs.
 */
const capabilityGuard = (conversation: ConversationTable, authenticated: boolean) => {
  // Refuse a blank token before it is ever compared.
  //
  // Historically this was load-bearing: `required: true` was observed to reject
  // an ABSENT param while ACCEPTING an empty string, so a `?session_token=`
  // request reached the comparison below — and authenticated rows left the
  // column at its `""` type default, so an empty token matched a logged-in
  // user's thread.
  //
  // ⚠ RE-VERIFIED against a live ephemeral (2026-08-17): the engine now rejects
  // an empty string exactly as it rejects an absent one, with
  // `400 ERROR_CODE_INPUT_ERROR "Missing param: session_token"`, BEFORE the stack
  // runs. Confirmed on all three guest endpoints, for both the query-string and
  // JSON-body forms. So this precondition is currently unreachable.
  //
  // It stays anyway, and deliberately:
  //   - the behaviour it guards against is an ENGINE detail that changed once
  //     already and is not part of any contract we control;
  //   - it costs one comparison on a request that is about to be refused;
  //   - removing it would make the guard depend on a write-side decision made in
  //     a different module (that authenticated rows now carry a real guid rather
  //     than the `""` default).
  // Do not delete it on the strength of a passing test — the test passes because
  // the engine refuses earlier, not because the value is safe to compare.
  const nonEmptyToken = s.precondition({
    expr: expr(inp("session_token"), "!=", c.text("")),
    error_type: "notfound",
    error: c.text("Conversation not found."),
  });

  const load = s.db.get({
    table: conversation,
    fieldName: "id",
    fieldValue: inp("conversation_id"),
    // `session_token` is `internal`; an explicit `output` list is what makes it
    // readable inside the stack. It is never placed in a response.
    output: authenticated ? ["id", "user_id", "session_token"] : ["id", "session_token"],
    as: "conversation",
  });

  // `safe: true` because `db.get` binds null on a miss and an unguarded dotted
  // ref through null is a 500 rather than a 404.
  const tokenMatches = s.precondition({
    expr: expr(ref("conversation.session_token", { safe: true }), "=", inp("session_token")),
    error_type: "notfound",
    error: c.text("Conversation not found."),
  });

  // Only meaningful when the authenticated family exists to claim things.
  const stillUnclaimed = s.precondition({
    expr: expr(ref("conversation.user_id", { safe: true }), "=", c.null()),
    error_type: "accessdenied",
    error: c.text("This conversation now belongs to an account. Sign in to continue it."),
  });

  // Two explicit `statements(...)` branches rather than one array with a
  // conditional spread. A spread of `cond ? [x] : []` is not a fixed tuple, so
  // it widens the consuming stack exactly as a plain `Statement[]` helper does —
  // and a widened stack resolves every `ref()` after it to `unknown` and infers
  // the query's response as `StackTupleWidened`. Each branch here is a literal
  // tuple, so both survive the spread. See `authenticated.ts`'s `ownershipGuard`.
  return authenticated
    ? statements(nonEmptyToken, load, tokenMatches, stillUnclaimed)
    : statements(nonEmptyToken, load, tokenMatches);
};

export function guestQueries(
  opts: ResolvedOptions,
  group: ChatbotGroup,
  conversation: ConversationTable,
  message: MessageTable,
  replyFn: GenerateReplyFn,
) {
  // No `auth` key at all — these are public by construction. Spelling it as
  // `auth: false` would read the same to core, but omitting it keeps "public" a
  // property of the family rather than a value someone could flip in one place.
  const base = { apiGroup: group, tags: opts.tags } as const;
  const guard = capabilityGuard(conversation, opts.authenticated);
  const p = opts.routePrefix;


  /**
   * Ceiling on the public, metered endpoints.
   *
   * Keyed on `sys.remoteIp()`, NOT `auth("id")`: `auth()` is null on a public
   * endpoint, so an auth-keyed limiter collapses every caller in the world into
   * ONE bucket — core warns about exactly this. The IP is the best signal
   * available here; it is a cost ceiling, not an anti-abuse control (one NAT
   * shares a bucket, a distributed source gets one each).
   *
   * Placed FIRST, before the capability guard, so token-guessing burns the
   * guesser's own budget.
   */
  const limit = (scope: string) =>
    opts.rateLimit
      ? statements(
          s.redis.ratelimit({
            key: withFilters(c.text(`${p}:guest:${scope}:`), fl.concat(sys.remoteIp())),
            max: c.int(opts.rateLimit.max),
            ttl: c.int(opts.rateLimit.ttl),
            error: c.text(opts.rateLimit.error),
          }),
        )
      : statements();

  /**
   * POST `chat/guest/conversations/create` — open an anonymous thread.
   *
   * The only endpoint that ever emits a `session_token`, and it does so from
   * `create_uuid`'s own binding rather than by re-reading the stored row.
   */
  const createConversation = query({
    ...base,
    name: `${p}/guest/conversations/create`,
    verb: "POST",
    description: "Create an anonymous conversation and return its session token",
    input: {
      title: input.text({
        methods: ["trim"],
        description: "Optional thread title. Left blank, the first message's opening words become the title.",
      }),
    },
    stack: [
      ...limit("create"),
      s.security.create_uuid({ as: "session_token" }),
      s.db.add({
        table: conversation,
        as: "conversation",
        output: PUBLIC_CONVERSATION_FIELDS,
        data: [
          { name: "created_at", value: c.text("now") },
          { name: "session_token", value: ref("session_token") },
          { name: "title", value: withFilters(inp("title"), fl.substr(c.int(0), c.int(TITLE_LENGTH))) },
          // `user_id` is deliberately not written. It stays null, which is what
          // marks the thread claimable.
        ],
      }),
    ],
    // Spread the conversation projection, then add the token beside it. The token
    // comes from `ref("session_token")` — the minted value — NOT from the written
    // row, so the `internal` column never has to be read back to serve it.
    response: {
      id: ref("conversation.id"),
      created_at: ref("conversation.created_at"),
      title: ref("conversation.title"),
      last_message_at: ref("conversation.last_message_at"),
      session_token: ref("session_token"),
    },
  });

  /** GET `chat/guest/conversations/{conversation_id}/messages` — the transcript. */
  const listMessages = query({
    ...base,
    name: `${p}/guest/conversations/{conversation_id}/messages`,
    verb: "GET",
    description: "Read a guest conversation's transcript, oldest message first",
    input: {
      conversation_id: input.int({ required: true }),
      session_token: input.text({
        required: true,
        description: "The token returned when the conversation was created.",
      }),
    },
    stack: [
      ...guard,
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

  /** POST `chat/guest/conversations/{conversation_id}/send` — say something, get a reply. */
  const sendMessage = query({
    ...base,
    name: `${p}/guest/conversations/{conversation_id}/send`,
    verb: "POST",
    description: "Append a message to a guest conversation and return the agent's reply",
    input: {
      conversation_id: input.int({ required: true }),
      session_token: input.text({ required: true }),
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
      ...limit("send"),
      ...guard,
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

  /** POST `chat/guest/conversations/{conversation_id}/delete` — discard a thread. */
  const deleteConversation = query({
    ...base,
    // A POST, not a DELETE. The token is the credential and it would have to
    // travel as a query string on a DELETE — into access logs, proxies and
    // `Referer` headers. A body keeps it out of the URL. Deliberate deviation
    // from the authenticated family, whose DELETE carries no secret in the URL.
    name: `${p}/guest/conversations/{conversation_id}/delete`,
    verb: "POST",
    description: "Delete a guest conversation and every message in it",
    input: {
      conversation_id: input.int({ required: true }),
      session_token: input.text({ required: true }),
    },
    stack: [
      ...guard,
      s.db.bulk.delete({
        table: message,
        where: expr(col("conversation_id"), "=", inp("conversation_id")),
      }),
      s.db.del({ table: conversation, fieldName: "id", fieldValue: inp("conversation_id") }),
    ],
    response: c.null(),
  });

  return {
    createConversation,
    listMessages,
    sendMessage,
    deleteConversation,
    all: [createConversation, listMessages, sendMessage, deleteConversation],
  };
}
