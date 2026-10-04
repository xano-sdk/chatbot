/**
 * `createChatbot(opts)` — build every def for one configuration.
 * `registerChatbot(xano, opts)` — build them and register them in one call.
 *
 * There is **no cross-call agreement checking** here, unlike `@xano-sdk/auth`'s
 * `registerAuth`. Auth needs it because its `authenticationGroup` is a
 * process-wide module singleton: a second `registerAuth` could silently retarget
 * the first workspace's group, and omitting an option could make one workspace
 * inherit another's canonical. Every def here is minted fresh per
 * `createChatbot` call, so two calls simply produce two independent sets and
 * there is nothing to reconcile.
 *
 * There IS an idempotency guard, for a different reason. Core's own duplicate-def
 * guard compares def **identity**, and two `createChatbot` calls produce distinct
 * objects that merely share names — so a second `registerChatbot` on one instance
 * slips past it and fails much later at `export()` with
 *
 *   Duplicate object guid (82dcb96…) shared by "dbo/conversation" and "dbo/conversation"
 *
 * which names one guid, the same label twice, and neither call. The WeakSet below
 * reports it at the call that made it.
 */
import type { Xano } from "@xano/sdk";
import { resolveOptions, type ChatbotOptions, type ResolvedOptions } from "./options.js";
import { conversationTable } from "./tables/conversation.js";
import { messageTable } from "./tables/message.js";
import { chatAgent } from "./agent/chat-agent.js";
import { generateReplyFn } from "./functions/generate-reply.js";
import { chatbotGroup } from "./api/group.js";
import { authenticatedQueries } from "./api/authenticated.js";
import { guestQueries } from "./api/guest.js";

/**
 * Instances that have already had a full set registered. A WeakSet so an instance
 * that goes out of scope is not retained by this module.
 */
const installed = new WeakSet<Xano>();

/** The token-authenticated endpoint family. */
export type AuthenticatedFamily = ReturnType<typeof authenticatedQueries>;
/** The public guest endpoint family. */
export type GuestFamily = ReturnType<typeof guestQueries>;

/**
 * Which families a given options object produces, decided at the type level.
 *
 * `authenticated` defaults to **true** and `guest` to **false**, so for the
 * overwhelmingly common call — `registerChatbot(xano, { authTable })` — these
 * resolve to a present `authenticated` and an absent `guest`, and a consumer
 * writes `bot.authenticated.sendMessage` with no `!`. Typing both as
 * `| undefined` unconditionally made every caller pay for a configuration
 * almost none of them use.
 *
 * A non-literal flag (`{ guest: someBoolean }`) is genuinely unknowable at
 * compile time, so it widens back to `… | undefined` — correct, and the only
 * case that still needs a check.
 *
 * ⚠ Written as structural `O extends { authenticated: … }` checks rather than the
 * shorter indexed access `O["authenticated"]`. When the key is ABSENT from `O`,
 * an indexed access falls back to the CONSTRAINT — `boolean | undefined` — so
 * every default install looked like a runtime boolean and stayed nullable, which
 * is the exact papercut this exists to remove. `extends` detects the missing key.
 */
export type AuthenticatedOf<O extends ChatbotOptions> = O extends { authenticated: false }
  ? undefined
  : O extends { authenticated: true }
    ? AuthenticatedFamily
    : O extends { authenticated: boolean }
      ? AuthenticatedFamily | undefined // a runtime boolean — unknowable
      : AuthenticatedFamily; // key absent → the `true` default

/** @see {@link AuthenticatedOf} — the same rule, inverted (guest is off by default). */
export type GuestOf<O extends ChatbotOptions> = O extends { guest: true }
  ? GuestFamily
  : O extends { guest: false }
    ? undefined
    : O extends { guest: boolean }
      ? GuestFamily | undefined // a runtime boolean — unknowable
      : undefined; // key absent → the `false` default

/**
 * Everything one `createChatbot` call produces.
 *
 * Parameterized by the options it was built from, so `authenticated` and `guest`
 * are present or absent according to those options rather than always nullable.
 * The bare `Chatbot` (no type argument) keeps both nullable — it describes *any*
 * configuration, which is what a variable annotated by hand should mean.
 */
export interface Chatbot<O extends ChatbotOptions = ChatbotOptions> {
  /** The resolved, fully-defaulted options these defs were built from. */
  options: ResolvedOptions;
  conversation: ReturnType<typeof conversationTable>;
  message: ReturnType<typeof messageTable>;
  agent: ReturnType<typeof chatAgent>;
  replyFn: ReturnType<typeof generateReplyFn>;
  group: ReturnType<typeof chatbotGroup>;
  /** The authenticated family. Absent only with `{ authenticated: false }`. */
  authenticated: AuthenticatedOf<O>;
  /** The guest family. Present only with `{ guest: true }`. */
  guest: GuestOf<O>;
  /** Every query def across both enabled families, ready for `registerQueries`. */
  queries: (AuthenticatedFamily["all"][number] | GuestFamily["all"][number])[];
}

/**
 * Build the full def set without registering anything.
 *
 * Reach for this over `registerChatbot` when you want to cherry-pick, reorder
 * registration around your own defs, or reference a def (the agent, the message
 * table) from a stack of your own. This is the cherry-pick path — a factory
 * package has no module-level def to import.
 *
 * ```ts
 * const bot = createChatbot({ authTable: userTable });
 * xano.registerTables([bot.conversation, bot.message]);
 * // …register only the endpoints you want
 * xano.registerQueries([bot.authenticated.sendMessage]);
 * ```
 *
 * Dependencies travel together: the queries need both tables, the reply function
 * and the agent; the reply function needs both tables and the agent. Registering
 * a query without them exports a reference to an object the workspace does not
 * hold, which fails the export.
 */
export function createChatbot<const O extends ChatbotOptions = Record<string, never>>(
  opts: O = {} as O,
): Chatbot<O> {
  const options = resolveOptions(opts);

  const conversation = conversationTable(options);
  const message = messageTable(options, conversation);
  const agent = chatAgent(options);
  const replyFn = generateReplyFn(options, conversation, message, agent);
  const group = chatbotGroup(options);

  const authenticated = options.authenticated
    ? authenticatedQueries(options, group, conversation, message, replyFn)
    : undefined;
  const guest = options.guest ? guestQueries(options, group, conversation, message, replyFn) : undefined;

  return {
    options,
    conversation,
    message,
    agent,
    replyFn,
    group,
    authenticated,
    guest,
    queries: [...(authenticated?.all ?? []), ...(guest?.all ?? [])],
    // The conditional families are decided by `AuthenticatedOf`/`GuestOf` from
    // the OPTIONS type, while the values above are decided by the RESOLVED
    // options at runtime. The two agree by construction — `resolveOptions`
    // applies exactly the defaults those conditionals encode — but the compiler
    // cannot see that a resolved boolean came from a literal, so the bridge is
    // asserted once, here, rather than by every caller writing `!`.
  } as Chatbot<O>;
}

/** What {@link registerChatbot} hands back: the def set, plus the instance it was registered on. */
export interface RegisteredChatbot<X extends Xano, O extends ChatbotOptions = ChatbotOptions>
  extends Chatbot<O> {
  /**
   * The instance the defs were registered on — the same object that was passed
   * in, for `export default`.
   */
  xano: X;
}

/**
 * Build and register the full set on the given instance.
 *
 * ```ts
 * import { workspace } from "@xano/sdk";
 * import { registerAuth, userTable } from "@xano-sdk/auth";
 * import { registerChatbot } from "@xano-sdk/chatbot";
 *
 * const xano = registerAuth(workspace("my-app"));
 * export const bot = registerChatbot(xano, { authTable: userTable });
 *
 * export default bot.xano;   // the default export must be the Xano registry
 * ```
 *
 * **Why this returns the defs and not the instance.** The defs are factories, so
 * a consumer has no `import { sendMessage }` to point `InferInput<typeof …>` at —
 * the handle returned here is the only route to the real, registered defs.
 * Returning the bare instance made the turnkey path structurally un-typeable and
 * pushed frontends into calling {@link createChatbot} a second time at runtime,
 * which drags the whole statement graph into the browser bundle to obtain a type
 * that erases. Exporting `bot` and importing it with `import type` costs nothing:
 *
 * ```ts
 * // frontend — erases completely at build time
 * import type { bot } from "../xano/index.js";
 * type Send = typeof bot.authenticated.sendMessage;
 * ```
 *
 * For the common shapes there is no need to drill at all — `SendMessageBody`,
 * `ChatReply`, `ListConversationsResponse` and friends are exported directly.
 *
 * Note what the example does *not* do: this package never registers the auth
 * table. It only references it, and a reference resolves through the same
 * name-derived guid the table itself emits, so registration order does not matter
 * — and a consumer whose auth table is already registered by `registerAuth` (or by
 * hand) does not get a duplicate.
 *
 * Use {@link createChatbot} when you want the defs *without* registering them —
 * to cherry-pick a subset, or to reference one from a stack of your own.
 */
export function registerChatbot<X extends Xano, const O extends ChatbotOptions = Record<string, never>>(
  xano: X,
  opts: O = {} as O,
): RegisteredChatbot<X, O> {
  if (installed.has(xano)) {
    throw new Error(
      "registerChatbot: already called on this Xano instance. Register the chatbot set once — a second " +
        "registration duplicates every def, which core cannot catch (the two sets are distinct objects " +
        'sharing names) and which surfaces at export() as "Duplicate object guid … shared by ' +
        '\\"dbo/conversation\\" and \\"dbo/conversation\\"". To run TWO chatbots in one workspace, give the ' +
        "second one its own `routePrefix` AND `names` — the prefix is what keeps the ENDPOINT guids " +
        "apart (a query's identity derives from its route name), and `names` keeps the tables, agent, " +
        "function and group apart: registerChatbot(xano, { routePrefix: 'support', names: { conversation: " +
        "'support_conversation', message: 'support_message', agent: 'support_agent', apiGroup: 'Support', " +
        "replyFn: 'support/reply' } }).",
    );
  }

  const bot = createChatbot(opts);

  xano
    .registerTables([bot.conversation, bot.message])
    .registerAgents([bot.agent])
    .registerFunctions([bot.replyFn])
    .registerApiGroups([bot.group])
    .registerQueries(bot.queries);

  installed.add(xano);
  return { ...bot, xano };
}
