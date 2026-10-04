/**
 * Response shapes this package hand-declares.
 *
 * Only one, and only because core's static walk genuinely cannot see it. Every
 * other endpoint's response IS derived — a projection off a `db.query`, a
 * `db.add`, or a `db.edit`, all of which the walk can read off the table schema
 * and the `output` list. Those stay underived on purpose, so editing a
 * `PUBLIC_*_FIELDS` array moves the consumer's type with it.
 */
import type { MessageRole } from "../tables/message.js";

/**
 * What the send endpoints (and the reply function) hand back.
 *
 * Declared rather than derived because `reply` is `ref("run.result")` — the
 * completion from `s.ai.agent.run`. The agent carries no `output.schema` (a chat
 * reply is free text), so core resolves the run envelope's `.result` to `unknown`,
 * and `unknown` propagating into every consumer's send call is the one place a
 * declaration earns itself here.
 *
 * `string` is an assumption about the provider's completion, not something core
 * pins — the same class of hand-maintained contract as `@xano-sdk/auth`'s
 * `authToken: string`. The type tests pin the declared *keys* against the keys the
 * walk does see, which is the part that can drift silently.
 */
export interface ChatReply {
  /** The thread the turn was appended to — echoed back for client-side routing. */
  conversation_id: number;
  /**
   * The assistant's reply.
   *
   * **Markdown.** The default system prompt asks for light markdown, because a
   * chat reply reads better rendered than as a wall of plain text. Render it with
   * a markdown component rather than dropping it into a text node — otherwise the
   * reader sees literal `**asterisks**`. (Using a plain-text UI? Override
   * `llm.systemPrompt` so the model stops emitting markup at all.)
   *
   * ⚠ **Render it as untrusted input.** This string is model output shaped by
   * whatever the user typed, so a prompt-injection attempt can try to steer it
   * into `<script>` or a `javascript:` link. Use a renderer with raw HTML
   * disabled (the default in `react-markdown` and `marked`), or sanitize before
   * `dangerouslySetInnerHTML`. The default prompt says not to emit raw HTML,
   * which is a nudge to a model, not a guarantee — the renderer is the control.
   */
  reply: string;
  /** The primary key of the stored assistant message. */
  message_id: number;
  /**
   * The NAMES of the tools the agent executed on this turn, in call order —
   * `[]` when the model answered directly, and `[]` on every turn of a
   * tool-less install.
   *
   * Names only, and deliberately. A tool call also carries the arguments the
   * model produced and whatever the tool returned; both are model-shaped, and a
   * tool that reads data would put that data on the wire for a client that only
   * asked "did anything run?". The name answers that and leaks nothing.
   *
   * ⚠ **Not an audit log.** A tool that THREW still appears here or does not,
   * according to what the engine records for the run — the field says which
   * tools the model reached for, not which of them succeeded. Read the rows a
   * tool should have written if you need to know it worked.
   */
  tool_calls: string[];
}

/** Re-exported for the docs' benefit; the role set lives with the table. */
export type { MessageRole };
