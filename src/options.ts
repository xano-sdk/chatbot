/**
 * The public configuration surface, plus the resolver that turns a caller's
 * partial options into the fully-defaulted `ResolvedOptions` every def factory
 * reads.
 *
 * Everything in this package is a **factory** rather than a module singleton,
 * and `authTable` is why. `f.tableRef` resolves its target's guid eagerly, at
 * column-construction time (core's `src/fields/catalog.ts` — `resolveRef("dbo",
 * table)` runs inside the field builder), so a module-level `conversation` def
 * would bake in one particular user reference the moment this module evaluated
 * and could never be re-pointed by a later `registerChatbot` call.
 *
 * That divergence from `@xano-sdk/auth`'s layout costs the
 * `import { conversationTable }` cherry-pick, and buys two things back. The
 * obvious one is a configurable auth table. The subtler one is that the ~100
 * lines of conflict guards in `@xano-sdk/auth`'s `register.ts` have no analogue
 * here: those exist because `authenticationGroup` is a process-wide singleton a
 * second `registerAuth` could silently retarget. Fresh defs per call cannot have
 * that bug, so this package needs no cross-call agreement checks.
 */
import type { LlmSettings, TableDef, ToolsetToolEntry, ToolsetToolRef } from "@xano/sdk";

/**
 * The auth table, as this package accepts it: a `table()` def handle or a bare
 * table name.
 *
 * Deliberately NARROWER than core's `AuthRef`, which also allows a raw numeric
 * `dbo.id`. That escape hatch is unusable here: the same table is both the
 * endpoints' `auth` (which takes a number happily) and the target of
 * `conversation.user_id`, and `f.tableRef` resolves through `ObjectRef` —
 * `string | { name, guid? }` — which has no numeric form. Accepting a number
 * would mean silently dropping the foreign key or demanding a second option
 * naming the same table twice, so it is refused at the type level instead.
 */
export type ChatbotAuthTable = TableDef | string;

/**
 * The LLM settings a caller may supply: core's `LlmSettings` with the run prompt
 * removed from every member of the union.
 *
 * Distributive on purpose — a plain `Omit<LlmSettings, …>` on a union collapses it
 * to the keys all members share, which would erase every provider-specific field
 * and make `{ type: "anthropic", thinkingTokens }` a type error.
 *
 * The removal makes `llm.prompt` a COMPILE error rather than only a runtime one.
 * `resolveOptions` still throws, because a JS caller (or options read from untyped
 * config) reaches neither check — but a TypeScript author finds out at the call
 * site, which is the whole point of the package being typed.
 *
 * ⚠ The two banned keys are re-declared as `?: never` rather than merely
 * `Omit`ted. Omission alone makes the rejection an EXCESS-PROPERTY check, which
 * fires for a direct object-literal assignment and silently stops firing the
 * moment the argument is inferred into a generic type parameter — as it now is,
 * so `createChatbot`/`registerChatbot` can tell which endpoint families a given
 * options object produces. `?: never` is a real assignability failure and
 * survives that inference.
 */
export type ChatbotLlmOptions = LlmSettings extends infer U
  ? U extends unknown
    ? Partial<Omit<U, "prompt" | "messages">> & { prompt?: never; messages?: never }
    : never
  : never;

/** Requests allowed per window, per caller, on the endpoints that cost money. */
export const DEFAULT_RATE_LIMIT_MAX = 20;
/** Rate-limit window, in seconds. */
export const DEFAULT_RATE_LIMIT_TTL = 60;

/**
 * Per-caller rate limiting on the endpoints that invoke the model.
 *
 * ON by default, because the guest family is **public and every send costs an
 * LLM call** — an unauthenticated, metered endpoint with no ceiling is the one
 * configuration a turnkey package should never ship. Same reasoning as request
 * history being off by default.
 *
 * Applied to the two `send` endpoints and to `guest/conversations/create` (the
 * only unauthenticated write). Reads are not limited: they are cheap and
 * limiting them mostly breaks legitimate UIs.
 *
 * Keys are per caller and per install:
 *
 * - authenticated → `auth("id")`, a real identity;
 * - guest → `sys.remoteIp()`, because `auth()` is null on a public endpoint and
 *   every caller would otherwise share ONE bucket — core warns about exactly
 *   this collapse.
 *
 * ⚠ An IP key is the best available signal on a public endpoint, not a strong
 * one: callers behind one NAT share a bucket, and a distributed source gets a
 * fresh bucket per address. Treat it as a cost ceiling, not an anti-abuse
 * control.
 *
 * Pass `false` to remove it entirely.
 */
export interface ChatbotRateLimit {
  /** Requests per window, per caller. Default {@link DEFAULT_RATE_LIMIT_MAX}. */
  max?: number;
  /** Window length in seconds. Default {@link DEFAULT_RATE_LIMIT_TTL}. */
  ttl?: number;
  /** Message returned when the limit is hit. */
  error?: string;
}

/**
 * The default system prompt — deliberately bland, meant to be replaced.
 *
 * The markdown sentence is the one part that is not filler. Replies read far
 * better in a chat UI when the frontend renders them as markdown, and that only
 * works if the model is actually told to produce it, so the shipped default and
 * the rendering advice in README.md are two halves of one decision.
 *
 * **Light** markdown on purpose. A model told simply to "use markdown" reaches
 * for headings and tables in a two-line answer, which reads worse than prose in a
 * chat bubble — and every element it uses is one more thing a frontend has to
 * style. Emphasis, lists and code spans cover what a conversational reply needs.
 *
 * If your frontend renders replies as PLAIN TEXT, override this: unrendered
 * markdown shows the reader literal `**asterisks**`, which is worse than the
 * prose it replaced. Pass your own `llm.systemPrompt` — that is the field this
 * package expects most installs to set.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, concise assistant. Answer the user's questions directly. " +
  "If you do not know something, say so rather than guessing. " +
  "Format replies as light Markdown — emphasis, bullet lists, and fenced code blocks " +
  "where they genuinely help. Keep it minimal: no headings or tables in a short answer, " +
  "and never wrap an ordinary sentence in formatting. Do not emit raw HTML.";

/**
 * Appended to the system prompt when — and only when — `tools` are configured.
 *
 * Two clauses, each earning its place from observed behaviour:
 *
 * 1. **"call the tool rather than saying you do not know."** Verified live: with
 *    a correctly wired tool but no mention of it in the prompt, the model
 *    answered "I do not know the secret word" and never called it — the default
 *    prompt's own "if you do not know something, say so rather than guessing"
 *    steers it away from trying. Asked by name it called the tool immediately.
 * 2. **"answer in your own words, never paste the raw tool response."** A tool
 *    result arrives wrapped in an engine envelope
 *    (`{"<tool>_response": {"content": …, "name": …}}`), and the model will
 *    happily paste that verbatim into `reply` — which then renders as a JSON
 *    blob in the UI. Observed exactly that before this clause existed.
 *
 * Kept to two sentences so it composes with a caller's own `systemPrompt`
 * instead of arguing with it.
 */
export const TOOLS_SYSTEM_PROMPT =
  " You have tools available. When a question needs information you do not have, " +
  "call the appropriate tool rather than guessing or saying you do not know. " +
  "Use what a tool returns to answer in your own words — never paste the raw tool " +
  "response or its wrapper into your reply.";

/** How many prior turns the send endpoint replays into the model. */
export const DEFAULT_HISTORY_LIMIT = 20;

/** How many conversations the list endpoint returns. */
export const DEFAULT_LIST_LIMIT = 100;

/** How many messages a transcript endpoint returns. */
export const DEFAULT_TRANSCRIPT_LIMIT = 200;

/** The default route prefix — the leading segment of every endpoint path. */
export const DEFAULT_ROUTE_PREFIX = "chat";

/** Default stored-object names. */
export const DEFAULT_NAMES = {
  conversation: "conversation",
  message: "conversation_message",
  replyFn: "chatbot/generate_reply",
  agent: "chatbot_agent",
  apiGroup: "Chatbot",
} as const;

/** Overridable stored-object names — see {@link ChatbotOptions.names}. */
export interface ChatbotNames {
  /** The conversation table. Default `"conversation"`. */
  conversation?: string;
  /**
   * The message table. Default `"conversation_message"` rather than the more
   * obvious `"message"`: a bare `message` is a name a realtime or notification
   * workspace plausibly already holds, and a collision surfaces as a duplicate
   * -guid throw at export rather than anything self-explanatory.
   */
  message?: string;
  /** The shared reply function. Default `"chatbot/generate_reply"`. */
  replyFn?: string;
  /** The agent. Default `"chatbot_agent"`. */
  agent?: string;
  /** The API group. Default `"Chatbot"`. */
  apiGroup?: string;
}

/** Options for `createChatbot` / `registerChatbot`. */
export interface ChatbotOptions {
  /**
   * The table conversations belong to, and the table the authenticated
   * endpoints authenticate against. Required whenever `authenticated` is on
   * (the default).
   *
   * Takes a `table()` def handle or a bare table name (see
   * {@link ChatbotAuthTable} for why a numeric `dbo.id` is not accepted).
   * **Nothing in this package imports `@xano-sdk/auth`**; handing it that
   * package's `userTable` is just the documented happy path:
   *
   * ```ts
   * import { userTable } from "@xano-sdk/auth";
   * registerChatbot(xano, { authTable: userTable });
   * ```
   *
   * Your own table works identically. `table({ auth: true })` is the convention,
   * not a mechanism: the engine gates a request by comparing the token's `dbo`
   * against the endpoint's configured `dbo` **by name**, and mints a token for
   * any table by name — neither side reads the flag, which is only an editor
   * concern (see core's `src/refs/auth.ts`). So a table without `auth: true`
   * authenticates fine; core merely warns at export.
   *
   * Prefer the **handle** over a bare name. A name carries no schema, so core
   * cannot check the referenced primary-key type against the `user_id` column —
   * an int/uuid mismatch then surfaces as a Xano import failure instead of an
   * author-time throw. Pass `{ userIdType: "uuid" }` alongside a uuid-keyed
   * table referenced by name.
   */
  authTable?: ChatbotAuthTable;

  /**
   * The primary-key type of `authTable`, and so the type of
   * `conversation.user_id`. Default `"int"`.
   *
   * Only needed when `authTable` is a bare **name** — a name carries no schema.
   * With a handle, core reads the target's `idType` and throws on a mismatch by
   * itself, so this option is redundant there (but still checked for agreement).
   */
  userIdType?: "int" | "uuid";

  /**
   * Register the token-authenticated endpoint family (`chat/*`), scoped by
   * `auth("id")`. Default `true`.
   *
   * Set `false` for a purely anonymous bot, in which case `authTable` may be
   * omitted entirely and `user_id` is dropped from the conversation table.
   */
  authenticated?: boolean;

  /**
   * Register the public guest endpoint family (`chat/guest/*`), scoped by an
   * unguessable `session_token`. Default `false`.
   *
   * Two families rather than one because a Xano endpoint's `auth` is **binary**
   * and there is no optional-auth flag: an authenticated endpoint returns 401
   * without a token, and referencing `auth()` inside a *public* stack raises
   * `ACCESS_DENIED` outright (verified against a live instance — see
   * AGENTS.md). One endpoint therefore cannot serve both callers, so each family
   * gets its own, and each has exactly one authorization rule to audit.
   *
   * ⚠ A guest conversation is protected by a bearer capability, not a login.
   * See the security notes in README.md before enabling this on a public site.
   */
  guest?: boolean;

  /**
   * The agent's LLM settings, passed through to core's `agent({ llm })`.
   *
   * Defaults to `{ type: "xano-free" }` — Xano's keyless provider, so a fresh
   * install answers a message without any credential wiring.
   *
   * `systemPrompt` defaults to {@link DEFAULT_SYSTEM_PROMPT} and is the one
   * field most installs will set. The **run prompt is not yours to set**: this
   * package owns it, because the conversation transcript is delivered through
   * it. Passing `prompt` or `messages` throws rather than silently losing the
   * history (core stores one prompt behind a `prompt_type` discriminator, so a
   * caller-supplied one would replace the transcript, not add to it).
   */
  llm?: ChatbotLlmOptions;

  /**
   * How many prior messages to replay into the model on each send. Default
   * {@link DEFAULT_HISTORY_LIMIT}. Must be a positive integer.
   *
   * The window is applied in the database (`db.query` + `sort` + `paging`), so a
   * long conversation costs a bounded read and a bounded context, not a growing
   * one. Raising it raises per-message token spend on every turn.
   */
  /**
   * How many messages of the thread are replayed to the model on each send.
   * Default {@link DEFAULT_HISTORY_LIMIT}.
   *
   * ⚠ A count of **messages (rows), including the turn being sent** — not of
   * exchanges. The user's message is written before the history is read, so the
   * usable memory is `historyLimit - 1` PRIOR messages, and a user+assistant
   * exchange costs two.
   *
   * Verified live: at `historyLimit: 2` the model is given
   * `[previous assistant reply, current user message]` — the user's own previous
   * statement is already outside the window, so "the codeword is X" followed by
   * "what was the codeword?" cannot be answered. The default of 20 is ~10
   * exchanges; treat anything below ~6 as effectively memoryless.
   *
   * Independent of `transcriptLimit`, so a user can see a message on screen that
   * the model was never shown.
   */
  historyLimit?: number;

  /**
   * How many conversations `GET chat/conversations` returns, newest-active first.
   * Default {@link DEFAULT_LIST_LIMIT}. Must be a positive integer.
   *
   * A fixed cap rather than caller-supplied paging: input-bound paging would let
   * an omitted `per_page` reach the engine as null, and a chat sidebar is not the
   * surface where that trade is worth making. A consumer who needs real paging
   * registers their own list endpoint over the same table.
   */
  listLimit?: number;
  /**
   * Per-caller rate limiting on the model-invoking endpoints. Defaults to
   * `{ max: 20, ttl: 60 }`; pass `false` to disable. See {@link ChatbotRateLimit}.
   */
  rateLimit?: false | ChatbotRateLimit;
  /**
   * Tools the chat agent may call — a `tool()` def handle, its name, or a
   * `{ tool, enabled?, auth? }` wrapper.
   *
   * Empty by default: a tool-less assistant is the right shape for a plain
   * chatbot, and a tool the model can call is a capability, not a decoration.
   *
   * ⚠ **This package references your tools; it never registers them.** Same rule
   * as `authTable`. Register them yourself:
   *
   * ```ts
   * const lookupOrder = tool({ name: "lookup_order", … });
   *
   * const bot = registerChatbot(xano, { authTable: userTable, tools: [lookupOrder] });
   * bot.xano.registerTools([lookupOrder]);
   * ```
   *
   * A reference resolves to a name-derived guid with no registry lookup, so a
   * tool you forget to register is caught at **export**, which THROWS naming the
   * tool and the fix — deliberately, since a mistyped name would otherwise
   * produce a valid-looking guid that only fails once the import has begun.
   *
   * Two things follow from adding tools:
   *
   * - **`llm.maxSteps` starts to matter.** It bounds reasoning/tool steps and
   *   defaults to 5; a chain needing more calls than that stops early.
   * - **A tool runs with the caller's request context.** If it reads data, scope
   *   it yourself — the agent will call it whenever the model decides to, on
   *   behalf of whoever is chatting, including an anonymous guest when the guest
   *   family is enabled.
   *
   * ## Per-tool auth is applied for you
   *
   * A toolset entry carries its own `auth`, and the engine's default is
   * `auth: false` — a **public** tool stack. `auth("id")` inside a public stack
   * does not resolve to null: it raises `ERROR_CODE_ACCESS_DENIED` on the first
   * statement that reads it. The agent swallows that throw, so the model still
   * answers "I saved your note" and nothing is written — no 500, no error in the
   * reply, no export warning (a live failure, recorded in AGENTS.md).
   *
   * So when {@link ChatbotOptions.authTable} is set, every entry that does not
   * name an `auth` of its own is given **that table**:
   *
   * ```ts
   * tools: [saveNote]                       // → { tool: saveNote, auth: userTable }
   * tools: [{ tool: saveNote }]             // → { tool: saveNote, auth: userTable }
   * tools: [{ tool: ping, auth: false }]    // → left public, the explicit opt-out
   * tools: [{ tool: saveNote, auth: other }] // → left alone
   * ```
   *
   * The tools belong to a bot whose endpoints are already token-gated, so a
   * public tool is almost never the intent. `{ tool, auth: false }` remains the
   * way to say it deliberately — and such a tool must not call `auth()`.
   *
   * ⚠ A **guest-only** install (`{ authenticated: false, guest: true }`) has no
   * auth table, so nothing is defaulted and every tool is public. A tool reached
   * from the guest family has no caller identity: do not write `auth()` in it,
   * and scope what it reads by the arguments the model supplies instead.
   */
  tools?: ToolsetToolEntry[];

  /**
   * How many messages the transcript endpoints return, oldest-first within the
   * window. Default {@link DEFAULT_TRANSCRIPT_LIMIT}. Must be a positive integer.
   *
   * The window takes the NEWEST messages, so a thread longer than this loses its
   * oldest turns from the response — the right end to drop for a UI that renders
   * from the bottom. Independent of `historyLimit`: what a human reads back and
   * what the model is given are different budgets.
   */
  transcriptLimit?: number;

  /**
   * Pin the API group's canonical — the `<canonical>` in
   * `/api:<canonical>/chat/conversations`.
   *
   * Omitted, identity comes from the consumer's `xano.lock` (or, with no lock, a
   * random segment assigned at import) and a bare `getPath()` throws. Pinning it
   * lets a browser resolve `getPath()` with no lock file. Must match
   * `[A-Za-z0-9_-]+`, and must be unique across the instance's API groups —
   * which this package cannot check, so a collision surfaces at Xano import.
   */
  canonical?: string;

  /**
   * Request-history capture for the API group the endpoints inherit from.
   * Default `false`.
   *
   * `false` rather than the engine's inherit-on for the same reason
   * `@xano-sdk/auth` overrides it: request history records the request body, and
   * on this package that body is the user's message text plus — on the guest
   * family — the `session_token` that grants access to the whole thread. A
   * turnkey install should not persist either into the workspace's history
   * store. `true` opts back in at the engine's default depth; a positive integer
   * sets the capture depth; `"all"` is unlimited.
   */
  history?: boolean | number | "all";

  /**
   * The leading path segment of every endpoint — `chat` in
   * `chat/conversations/{id}/send`. Default {@link DEFAULT_ROUTE_PREFIX}.
   *
   * This is the second half of running TWO chatbots in one workspace. `names`
   * renames the stored objects, but a query's identity derives from its **route
   * name**, so a second install also needs its own prefix or every endpoint
   * collides on guid. Slashes are allowed (`"support/chat"`); braces are not,
   * since a prefix is not a place for a path param.
   */
  routePrefix?: string;

  /** Override the stored object names — see {@link ChatbotNames}. */
  names?: ChatbotNames;

  /** Tags applied to every def this package creates. Default `["xano:chatbot"]`. */
  tags?: string[];
}

/** Fully-defaulted options, as the def factories consume them. */
export interface ResolvedOptions {
  /** `undefined` exactly when the authenticated family is off. */
  authTable: ChatbotAuthTable | undefined;
  userIdType: "int" | "uuid";
  authenticated: boolean;
  guest: boolean;
  llm: LlmSettings;
  historyLimit: number;
  listLimit: number;
  /** Resolved rate limit, or `false` when disabled. */
  rateLimit: false | { max: number; ttl: number; error: string };
  /**
   * Tools the agent may call. Empty unless the caller supplied some.
   *
   * Normalized, not verbatim: with an auth table, every entry that named no
   * `auth` of its own is now `{ tool, auth: <authTable> }` — see
   * {@link ChatbotOptions.tools}. An explicit `auth: false` survives.
   */
  tools: ToolsetToolEntry[];
  transcriptLimit: number;
  canonical: string | undefined;
  history: boolean | number | "all";
  routePrefix: string;
  names: Required<ChatbotNames>;
  tags: string[];
}

const CANONICAL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Is this entry the `{ tool | id, enabled?, auth? }` WRAPPER, rather than a bare
 * `tool()` handle?
 *
 * The same discriminator core's own `normalizeToolEntry` uses: a wrapper names
 * its target through `tool` or `id`, while a handle carries its identity in its
 * own `name`. Testing for `auth`/`enabled` instead would misread a `tool()` def —
 * a `ToolDef` has an `enabled` field of its own, which is the TOOL's switch, not
 * a toolset entry's.
 */
function isToolWrapper(entry: object): entry is ToolsetToolRef {
  const ref = entry as ToolsetToolRef;
  return ref.tool !== undefined || ref.id !== undefined;
}

/**
 * Give each tool entry the chatbot's auth table unless the author named an
 * `auth` themselves — the fix for the silent-failure mode described on
 * {@link ChatbotOptions.tools}.
 *
 * Three rules, and each says something different:
 *
 * - a bare handle or name → wrapped as `{ tool, auth: authTable }`;
 * - a wrapper with no `auth` key → `auth: authTable` added, other fields kept;
 * - a wrapper whose `auth` is anything at all — another table, or `false` — is
 *   returned untouched. `false` is the documented opt-out and must keep working,
 *   because a tool that genuinely serves guests has to stay public.
 *
 * Called only when an auth table exists. A guest-only install has none, so its
 * tools stay public and this never runs.
 */
export function applyDefaultToolAuth(
  tools: ToolsetToolEntry[],
  authTable: ChatbotAuthTable,
): ToolsetToolEntry[] {
  return tools.map((entry) => {
    if (typeof entry === "object" && entry !== null && isToolWrapper(entry)) {
      return "auth" in entry && entry.auth !== undefined ? entry : { ...entry, auth: authTable };
    }
    // A bare `tool()` handle or a tool name — the spelling that produced the
    // public stack. `ObjectRef` takes either, so no branch is needed here.
    return { tool: entry as Exclude<ToolsetToolEntry, ToolsetToolRef>, auth: authTable };
  });
}

/** Does this entry deliberately stay public (`auth: false`)? */
const isPublicToolEntry = (entry: ToolsetToolEntry): boolean =>
  typeof entry === "object" && entry !== null && isToolWrapper(entry) && entry.auth === false;

/** Render a value for an error message without `JSON.stringify`'s NaN→null lie. */
const show = (v: unknown) => (typeof v === "number" ? String(v) : JSON.stringify(v));

/**
 * Resolve and validate options. Every check lives here, before any def is
 * built, so a bad call produces one clear error rather than a half-built
 * workspace or an opaque throw from deep inside core's encoder.
 */
export function resolveOptions(opts: ChatbotOptions = {}): ResolvedOptions {
  const authenticated = opts.authenticated ?? true;
  const guest = opts.guest ?? false;

  if (!authenticated && !guest) {
    throw new Error(
      "createChatbot: both endpoint families are disabled ({ authenticated: false, guest: false }), " +
        "which would register tables and an agent with no way to reach them. Enable at least one.",
    );
  }

  // Only the authenticated family needs an auth table: it is both the `auth` of
  // every endpoint in that family and the target of `conversation.user_id`. A
  // guest-only install has neither, so requiring one there would be theatre.
  if (authenticated && opts.authTable === undefined) {
    // The key is present but its value is not: `{ authTable: userTable }` with
    // `userTable` undefined at call time. "Pass authTable" would be wrong advice.
    if ("authTable" in opts) {
      throw new Error(
        "createChatbot: `authTable` was passed but is undefined at the time registerChatbot/createChatbot ran. " +
          "The table handle you passed has not been initialized yet — usually a circular import (the file " +
          "defining the table imports, directly or indirectly, the file calling registerChatbot), or an import " +
          "of a name the module does not export. Define the table in a module that does not import the chatbot " +
          "wiring, or pass its name as a string.",
      );
    }
    throw new Error(
      "createChatbot: `authTable` is required when the authenticated endpoint family is enabled. " +
        "Pass the table conversations belong to — a table() handle (preferred) or its name: " +
        '`registerChatbot(xano, { authTable: userTable })`. For an anonymous-only bot pass ' +
        "{ authenticated: false, guest: true } instead, which needs no auth table.",
    );
  }

  const userIdType = opts.userIdType ?? "int";
  if (userIdType !== "int" && userIdType !== "uuid") {
    throw new Error(
      `createChatbot: userIdType ${show(userIdType)} is not valid — pass "int" (the default) or "uuid". ` +
        "It must match the primary-key type of `authTable`; Xano allows no other primary-key type.",
    );
  }

  const limits = {
    historyLimit: {
      value: opts.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      note: "It caps how many prior messages are replayed into the model on each send.",
    },
    listLimit: {
      value: opts.listLimit ?? DEFAULT_LIST_LIMIT,
      note: "It caps how many conversations the list endpoint returns.",
    },
    transcriptLimit: {
      value: opts.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT,
      note: "It caps how many messages a transcript endpoint returns.",
    },
  } as const;
  for (const [name, { value, note }] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `createChatbot: ${name} ${show(value)} is not valid — pass a positive integer. ${note}`,
      );
    }
  }

  let rateLimit: ResolvedOptions["rateLimit"] = false;
  if (opts.rateLimit !== false) {
    const rl = opts.rateLimit ?? {};
    if (typeof rl !== "object" || rl === null) {
      throw new Error(
        `createChatbot: rateLimit ${show(rl)} is not valid — pass an object ` +
          "({ max?, ttl?, error? }) or `false` to disable it.",
      );
    }
    const max = rl.max ?? DEFAULT_RATE_LIMIT_MAX;
    const ttl = rl.ttl ?? DEFAULT_RATE_LIMIT_TTL;
    for (const [name, value] of Object.entries({ max, ttl })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(
          `createChatbot: rateLimit.${name} ${show(value)} is not valid — pass a positive integer. ` +
            "It bounds the model-invoking endpoints per caller; pass `rateLimit: false` to remove the limit.",
        );
      }
    }
    if (rl.error !== undefined && (typeof rl.error !== "string" || rl.error.length === 0)) {
      throw new Error(
        `createChatbot: rateLimit.error ${show(rl.error)} is not valid — pass a non-empty string.`,
      );
    }
    rateLimit = { max, ttl, error: rl.error ?? "Too many messages. Please wait a moment and try again." };
  }

  const authoredTools = opts.tools ?? [];
  if (!Array.isArray(authoredTools)) {
    throw new Error(
      `createChatbot: tools ${show(opts.tools)} is not valid — pass an array of tool() handles, ` +
        "tool names, or { tool, enabled?, auth? } entries.",
    );
  }
  for (const [i, entry] of authoredTools.entries()) {
    const ok =
      (typeof entry === "string" && entry.length > 0) ||
      (typeof entry === "object" && entry !== null);
    if (!ok) {
      throw new Error(
        `createChatbot: tools[${i}] ${show(entry)} is not valid — pass a tool() handle, a non-empty ` +
          "tool name, or a { tool, enabled?, auth? } entry.",
      );
    }
  }

  // Per-tool auth. See `ChatbotOptions.tools`: the engine's default for a
  // toolset entry is `auth: false`, a PUBLIC stack, in which `auth("id")` raises
  // ACCESS_DENIED rather than resolving to null — and the agent swallows the
  // throw, so the model reports success and nothing is written. An install with
  // an auth table almost never means that, so the table is applied to every
  // entry that does not name an `auth` of its own.
  const scopedAgainst = authenticated ? opts.authTable : undefined;
  const tools =
    scopedAgainst !== undefined ? applyDefaultToolAuth(authoredTools, scopedAgainst) : authoredTools;

  // A tool scoped to the auth table has no caller to bind to on the PUBLIC guest
  // endpoints, which is the same failure inverted. Nothing here can fix it —
  // one agent serves both families and a toolset entry carries one `auth` — so
  // the mixed install is reported rather than silently shipped.
  if (scopedAgainst !== undefined && guest && tools.some((entry) => !isPublicToolEntry(entry))) {
    console.warn(
      "xanosdk: chatbot — both endpoint families are enabled and the agent's tools are scoped to the " +
        "auth table, so a tool binds the caller on the authenticated endpoints and has no identity to " +
        "bind on the PUBLIC guest ones. One agent serves both families and an entry carries one `auth`, " +
        "so this cannot be resolved for you. Give a tool the model may call for a guest " +
        "`{ tool, auth: false }` and keep `auth()` out of it, or register the guest bot as its own " +
        "chatbot (own `routePrefix` and `names`) with its own tools.",
    );
  }

  if (opts.canonical !== undefined) {
    if (typeof opts.canonical !== "string" || !CANONICAL_PATTERN.test(opts.canonical)) {
      throw new Error(
        `createChatbot: canonical ${show(opts.canonical)} is not a valid URL segment — it must be a ` +
          'non-empty string matching [A-Za-z0-9_-]+ (the alphabet Xano mints). It becomes the ' +
          '"<canonical>" in /api:<canonical>/chat/conversations.',
      );
    }
  }

  const routePrefix = opts.routePrefix ?? DEFAULT_ROUTE_PREFIX;
  if (
    typeof routePrefix !== "string" ||
    !/^[A-Za-z0-9_\-/]+$/.test(routePrefix) ||
    routePrefix.startsWith("/") ||
    routePrefix.endsWith("/")
  ) {
    throw new Error(
      `createChatbot: routePrefix ${show(routePrefix)} is not valid — pass a non-empty path segment ` +
        "matching [A-Za-z0-9_-/]+ with no leading or trailing slash (e.g. \"chat\" or \"support/chat\"). " +
        "It becomes the leading segment of every endpoint, as in <prefix>/conversations/{id}/send. " +
        "A `{param}` marker is rejected: a prefix is not a place for a path param.",
    );
  }

  const history = opts.history ?? false;
  if (
    !(typeof history === "boolean" || history === "all" || (typeof history === "number" && Number.isInteger(history) && history > 0))
  ) {
    throw new Error(
      `createChatbot: history ${show(history)} is not a valid setting — pass \`false\` (off, the default), ` +
        '`true` (on at the engine\'s default capture depth), a positive integer (capture depth), or "all" ' +
        "(unlimited depth). The depth caps statements captured per record, not retention.",
    );
  }

  // The run prompt carries the transcript, so it is this package's to own.
  // Core stores ONE prompt behind a `prompt_type` discriminator, so a
  // caller-supplied one would REPLACE the history rather than add to it — the
  // exact silent-prompt-loss failure core's own `prompt` XOR `messages` union
  // exists to prevent. Refuse it instead.
  const llmIn = opts.llm ?? {};
  for (const field of ["prompt", "messages"] as const) {
    if (field in llmIn && (llmIn as Record<string, unknown>)[field] !== undefined) {
      throw new Error(
        `createChatbot: llm.${field} is not configurable — this package owns the agent's run prompt, ` +
          "because that is how the conversation transcript reaches the model. Xano stores ONE prompt " +
          `behind a prompt_type discriminator, so a supplied \`${field}\` would replace the transcript ` +
          "rather than add to it. Put your instructions in `llm.systemPrompt`, which is passed through.",
      );
    }
  }

  // A tool the model never reaches for is dead weight, so when tools are
  // configured the prompt says they exist — appended to the CALLER's prompt too,
  // since they may not know the model needs telling. See TOOLS_SYSTEM_PROMPT.
  const basePrompt = (llmIn as { systemPrompt?: string }).systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = tools.length > 0 ? basePrompt + TOOLS_SYSTEM_PROMPT : basePrompt;

  const llm = {
    type: "xano-free",
    ...llmIn,
    systemPrompt,
    // Set last: the transcript delivery mechanism, verified against a live
    // instance. See `src/agent/chat-agent.ts` for why `messages` and not `prompt`.
    messages: MESSAGES_TEMPLATE,
  } as LlmSettings;

  return {
    authTable: opts.authTable,
    userIdType,
    authenticated,
    guest,
    llm,
    historyLimit: limits.historyLimit.value,
    listLimit: limits.listLimit.value,
    rateLimit,
    tools,
    transcriptLimit: limits.transcriptLimit.value,
    canonical: opts.canonical,
    history,
    routePrefix,
    names: { ...DEFAULT_NAMES, ...opts.names },
    tags: opts.tags ?? ["xano:chatbot"],
  };
}

/**
 * The agent's run prompt: the whole conversation, as a rendered `messages`
 * template. See `src/agent/chat-agent.ts` for the verification behind it.
 */
export const MESSAGES_TEMPLATE = "{{ $args.messages }}";
