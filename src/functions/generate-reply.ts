/**
 * `chatbot/generate_reply` — append a user turn, run the agent over the thread's
 * recent history, append the reply, and return it.
 *
 * This is the one copy of the interesting logic. Both endpoint families call it
 * *after* doing their own authorization, which is the whole reason it exists as a
 * function: the authenticated and guest send endpoints differ only in how they
 * prove the caller owns the thread, and nothing about generating a reply should
 * be duplicated across that difference.
 *
 * ⚠ It performs NO authorization of its own. It trusts `conversation_id`
 * completely. A consumer calling it directly from their own stack owns that
 * check — see the note in README.md.
 *
 * ## Ordering is behaviour
 *
 * The user's turn is written **before** the history is read, so the read that
 * builds the model's context includes the message being answered. That is not an
 * optimization: the engine rejects an empty `messages` array with a fatal error,
 * and on the first turn of a fresh conversation the prior history is empty, so
 * appending first is what guarantees the array always has at least one element.
 */
import { defineFunction, input, s, c, inp, ref, expr, obj, col, withFilters, fl } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";
import type { ConversationTable } from "../tables/conversation.js";
import type { MessageTable } from "../tables/message.js";
import type { ChatAgent } from "../agent/chat-agent.js";
import type { ChatReply } from "../api/types.js";

/** How many characters of the first message become the auto-generated title. */
export const TITLE_LENGTH = 60;

export function generateReplyFn(
  opts: ResolvedOptions,
  conversation: ConversationTable,
  message: MessageTable,
  chatAgent: ChatAgent,
) {
  return defineFunction({
    name: opts.names.replyFn,
    description:
      "Appends a user message, runs the chat agent over recent history, appends the reply, and returns it. Performs no authorization.",
    tags: opts.tags,
    input: {
      conversation_id: input.int({
        required: true,
        description: "The thread to append to. NOT authorized here — the caller must have checked ownership.",
      }),
      content: input.text({
        required: true,
        description: "The user's message text. Must be non-empty.",
      }),
    },
    stack: [
      // Defence in depth. Every endpoint in this package already rejects a blank
      // message, so reaching this is a direct-caller mistake — but the failure it
      // prevents is silent rather than loud, which is what earns it a second
      // check here. An empty turn does not error at the provider; the model
      // receives a blank message and fabricates a plausible prior conversation
      // (verified — see AGENTS.md). A confabulated reply written into the
      // transcript then poisons every subsequent turn's context.
      // Compared TRIMMED: the endpoints trim at the input, but a direct
      // `s.function.run` caller supplies `content` straight into this function
      // and no input method runs for them. Comparing the raw value would let
      // "   " through on that path.
      s.precondition({
        expr: expr(withFilters(inp("content"), fl.trim()), "!=", c.text("")),
        error_type: "badrequest",
        error: c.text("Message content cannot be empty."),
      }),

      // 1. The user's turn. Written first so the history read below includes it —
      //    see the ordering note in the module header.
      s.db.add({
        table: message,
        as: "user_message",
        data: [
          { name: "created_at", value: c.text("now") },
          { name: "conversation_id", value: inp("conversation_id") },
          { name: "role", value: c.text("user") },
          { name: "content", value: inp("content") },
        ],
      }),

      // 2. The context window: the most recent `historyLimit` turns of this
      //    thread. Sorted DESC and capped in the database so a long conversation
      //    costs a bounded read — then reversed below, because the model needs
      //    them oldest-first. `id` breaks a `created_at` tie: two messages written
      //    in the same second must still order deterministically, or a turn can
      //    appear to precede the one it answered.
      s.db.query({
        table: message,
        where: expr(col("conversation_id"), "=", inp("conversation_id")),
        output: ["role", "content"],
        sort: [
          { sortBy: "created_at", dir: "desc" },
          { sortBy: "id", dir: "desc" },
        ],
        // `metadata: false` keeps this a bare array rather than the engine's
        // paging envelope — `fl.reverse` and the map below both want the array.
        paging: { per_page: opts.historyLimit, metadata: false },
        as: "recent",
      }),

      // 3. Build exactly `[{ role, content }]`, oldest first.
      //
      //    The projection is explicit rather than relying on the `output` list
      //    above. Extra keys are tolerated by the engine (verified), so this is
      //    not load-bearing today — it is load-bearing the moment someone adds a
      //    column to the message table, at which point the shape the provider
      //    sees stops depending on an `output` list edited in a different file.
      s.array.map({
        source: withFilters(ref("recent"), fl.reverse()),
        transform: { role: ref("$this.role"), content: ref("$this.content") },
        as: "turns",
      }),

      // 4. Render to JSON text. `messages` is a Twig-templated STRING, so the
      //    array has to arrive as its JSON serialization; the engine decodes it
      //    back into real message roles on the other side (verified — AGENTS.md).
      s.set_var("messages_json", withFilters(ref("turns"), fl.json_encode())),

      // 5. Run the agent. `args.messages` is what `{{ $args.messages }}` in the
      //    agent's `messages` template resolves to.
      s.ai.agent.run({
        agent: chatAgent,
        args: obj({ messages: ref("messages_json") }),
        // Attaching tools to the agent is NOT enough — the RUN has to permit
        // executing them. Without this the model is told the tools exist and can
        // never call one, so it answers "I don't have access to that" and the
        // whole feature silently does nothing (observed live before this line
        // existed). Emitted only when tools are configured, so a tool-less
        // install's bundle is unchanged.
        ...(opts.tools.length > 0 ? { allowToolExecution: c.bool(true) } : {}),
        as: "run",
      }),

      // 5b. The names of the tools this run actually executed — the only
      //     observable a client has that a tool ran at all. It exists because a
      //     live debugging session cost three deploy cycles when `tool_calls`
      //     came back null whether a tool had run, thrown, or never been called
      //     (see AGENTS.md).
      //
      //     ⚠ WHERE the calls live was settled against a live instance, because
      //     the two obvious answers are both wrong. This package used to read
      //     `run.tool_calls`, a key the envelope does not carry. Core types the
      //     envelope with a top-level `toolCalls` — which IS present and is
      //     always `[]` on a live run, even one whose tool wrote a row. The
      //     calls are in
      //     `steps[].content[]`: one entry of `type: "tool-call"` carrying
      //     `toolName`, followed by a `tool-result` entry carrying the tool's
      //     whole return value.
      //
      //     NAMES only, never the entries. A tool-call carries the arguments the
      //     model produced and a tool-result carries what the tool returned;
      //     both can hold data the caller never asked for. The name is the whole
      //     of what a client needs to know a tool ran.
      //
      //     A loop rather than the one-line `fl.map` lambda that also works
      //     (verified). Core is explicit that a lambda is an escape hatch drawing
      //     on a workspace-wide worker pool, and every send in every install
      //     would pay it — for work four ordinary statements express.
      //
      //     Emitted only when tools are configured, so a tool-less install's
      //     bundle is unchanged — the same rule as `allowToolExecution` above.
      ...(opts.tools.length > 0
        ? [
            // `fl.get` with a default rather than `ref(..., { safe: true })`:
            // the safe form defaults to NULL, and looping over null is not a
            // shape worth relying on. No steps means no names.
            s.set_var("run_steps", withFilters(ref("run"), fl.get(c.text("steps"), c.array([])))),
            s.set_var("tool_call_names", c.array([])),
            s.foreach({
              as: "step",
              list: ref("run_steps"),
              body: [
                // `index_by` groups the step's parts by `type` and `get` takes
                // one group — which is how the tool-CALLS are kept apart from
                // the tool-RESULTS. Both carry `toolName`, so skipping this
                // would report every call twice.
                s.set_var(
                  "step_calls",
                  withFilters(
                    ref("step.content", { safe: true }),
                    fl.safe_array(),
                    fl.index_by(c.text("type")),
                    fl.get(c.text("tool-call"), c.array([])),
                  ),
                ),
                s.array.map({
                  source: ref("step_calls"),
                  as: "step_names",
                  // The entry's key for the name is not a contract this package
                  // owns, so all three spellings are tried and the first
                  // non-null wins. Safe refs throughout: a missing key must
                  // resolve to null, not take the request down.
                  transform: withFilters(
                    ref("$this.toolName", { safe: true }),
                    fl.first_notnull(ref("$this.tool_name", { safe: true })),
                    fl.first_notnull(ref("$this.name", { safe: true })),
                  ),
                }),
                // Append, so a tool called twice is reported twice and the order
                // is the order the model called them in.
                s.set_var(
                  "tool_call_names",
                  withFilters(ref("tool_call_names"), fl.array_merge(ref("step_names"))),
                ),
              ],
            }),
          ]
        : []),

      // 6. A blank completion would fail the message table's `min:1` check as an
      //    opaque column-validation error naming a column the caller never sent.
      //    Report it as what it is instead: the model returned nothing.
      s.precondition({
        expr: expr(ref("run.result"), "!=", c.text("")),
        error_type: "standard",
        error: c.text("The assistant returned an empty reply. Try again."),
      }),

      // 7. The assistant's turn.
      s.db.add({
        table: message,
        as: "assistant_message",
        data: [
          { name: "created_at", value: c.text("now") },
          { name: "conversation_id", value: inp("conversation_id") },
          { name: "role", value: c.text("assistant") },
          { name: "content", value: ref("run.result") },
        ],
      }),

      // 8. Touch the thread so a conversation list can sort by recency without
      //    joining the message table. Read first, because the title is seeded
      //    from the first message only when it is still blank.
      s.db.get({
        table: conversation,
        fieldName: "id",
        fieldValue: inp("conversation_id"),
        output: ["id", "title"],
        as: "conversation",
      }),
      s.conditional({
        when: expr(ref("conversation.title"), "=", c.text("")),
        then: [
          s.db.edit({
            table: conversation,
            fieldName: "id",
            fieldValue: inp("conversation_id"),
            data: [
              { name: "last_message_at", value: c.text("now") },
              // First message wins the title, truncated. `substr` rather than a
              // model-generated summary on purpose: titling is not worth a second
              // LLM call on the request path, and a deterministic prefix cannot
              // fail, cost tokens, or return something unsafe to display.
              {
                name: "title",
                value: withFilters(inp("content"), fl.substr(c.int(0), c.int(TITLE_LENGTH))),
              },
            ],
          }),
        ],
        else: [
          s.db.edit({
            table: conversation,
            fieldName: "id",
            fieldValue: inp("conversation_id"),
            data: [{ name: "last_message_at", value: c.text("now") }],
          }),
        ],
      }),
    ],
    response: {
      conversation_id: inp("conversation_id"),
      reply: ref("run.result"),
      message_id: ref("assistant_message.id"),
      // Always an ARRAY of tool names, never null — see step 5b. A tool-less
      // install returns the empty array as a constant: no tool can have run, and
      // a client's `tool_calls.length` should not have to branch on how the bot
      // was configured. `filter_null` drops any record whose name could not be
      // read, so the field never reports a call it cannot name.
      tool_calls:
        opts.tools.length > 0
          ? withFilters(ref("tool_call_names"), fl.filter_null())
          : c.array([]),
    },
    // Declared for the same reason the send endpoints declare it (see
    // `api/types.ts`), and load-bearing for the build: a `function.run` of this
    // def carries `InferResponse` of it, and the derived shape
    // is too deep for the dts emit of either send endpoint (TS2589).
    responseShape: {} as ChatReply,
  });
}

/** The reply function's def type. */
export type GenerateReplyFn = ReturnType<typeof generateReplyFn>;
