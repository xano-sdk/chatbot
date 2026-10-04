/**
 * The chat agent.
 *
 * ## Why `messages` and not `prompt`
 *
 * Core stores ONE run prompt behind a `prompt_type` discriminator: either a
 * `prompt` string or a `prompt_messages` template, never both. Both are plain
 * strings rendered through Twig before the provider call, so "the transcript" can
 * be delivered either way — as prose interpolated into `prompt`, or as a JSON
 * array of role/content pairs rendered into `messages`.
 *
 * Which one the engine actually understands is not documented. It was settled by
 * probing a live instance with two otherwise-identical agents (findings recorded
 * in AGENTS.md). `messages` **is** genuinely decoded into real LLM message roles:
 *
 *   | payload passed to the template   | `prompt`                  | `messages`   |
 *   | -------------------------------- | ------------------------- | ------------ |
 *   | valid `[{role,content}]` array   | works, 110 input tokens   | works, 89    |
 *   | plain text, not an array         | works                     | ERROR_FATAL  |
 *   | malformed JSON                   | works, echoes the syntax  | ERROR_FATAL  |
 *   | `[]`                             | works                     | ERROR_FATAL  |
 *   | role outside the provider's set  | works                     | ERROR_FATAL  |
 *
 * The refusals are the proof: a literal string cannot be malformed, so a payload
 * that fails only under `messages` is one the engine parsed. The token counts say
 * the same thing quantitatively — the same conversation costs 21 fewer input
 * tokens as `messages`, because the JSON punctuation and the `"role"`/`"content"`
 * keys never reach the model. Under `prompt` they do, and the model is left to
 * infer the turn structure from syntax it can see.
 *
 * So `messages` is both cheaper and semantically correct, and its strictness is
 * a feature: the failure modes are loud. The cost is that every one of them is a
 * fatal 500 rather than a soft degradation, which is why the schema in
 * `src/tables/message.ts` makes the two row-level triggers (bad role, empty
 * content) unstorable, and why the reply function always appends the current turn
 * so the array is never `[]`.
 */
import { agent } from "@xano/sdk";
import type { ResolvedOptions } from "../options.js";

/**
 * Build the agent def.
 *
 * `llm` arrives already merged and validated by `resolveOptions`, which also
 * pins `messages` to the template and refuses a caller-supplied `prompt` /
 * `messages` — see `src/options.ts`.
 *
 * `tools` comes from `opts.tools` and is empty by default — a tool-less agent is
 * the right shape for a plain conversational assistant. When a consumer supplies
 * tools, this package REFERENCES them and never registers them, exactly as it
 * treats `authTable`; see `ChatbotOptions.tools`.
 *
 * No `output` schema, and that one is not configurable. `ChatReply.reply` is
 * declared `string` and the send endpoints hand `run.result` straight back, so a
 * structured-output schema would make `.result` an object where every consumer's
 * type — and every markdown renderer — expects text. A caller who wants
 * structured data should give the agent a TOOL that writes it, and keep the
 * reply itself free text.
 */
export function chatAgent(opts: ResolvedOptions) {
  return agent({
    name: opts.names.agent,
    description:
      "Conversational assistant. Receives the thread's recent turns as decoded LLM messages and returns the next one.",
    tags: opts.tags,
    tools: opts.tools,
    llm: opts.llm,
  });
}

/** The agent def type. */
export type ChatAgent = ReturnType<typeof chatAgent>;
