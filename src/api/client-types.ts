/**
 * Request and response types for every endpoint — what a client sends and gets
 * back, and **where each input travels**.
 *
 * These exist because the defs are **factories** (see `register.ts`), so there is
 * no module-level `sendMessage` to write `InferInput<typeof sendMessage>`
 * against. Reaching the handles through the factory's return type is a type-level
 * operation — nothing is built, nothing is evaluated — so a browser importing
 * these pulls in no statement stack and no SDK runtime.
 *
 * ## The naming rule
 *
 * Every name is `<HandleName><Part>`, where the handle name is exactly the
 * property on `bot.authenticated` / `bot.guest` (`sendMessage` →
 * `SendMessage…`). One vocabulary for the def, the type, and the endpoint map.
 *
 * | part | is | goes |
 * |---|---|---|
 * | `…Params` | path parameters | interpolated into the URL |
 * | `…Query` | query-string parameters | `?a=b` |
 * | `…Body` | the JSON body | the request body |
 * | `…Input` | everything core derives — all three at once | — |
 * | `…Response` | what comes back | — |
 *
 * A part that an endpoint does not have is simply not exported for it, so the
 * presence of a name is itself the answer to "does this take a body?".
 *
 * **Why the split matters.** `…Input` alone is not enough to write a request:
 * `SendMessageInput` contains `conversation_id`, but that is read off the URL,
 * so `JSON.stringify(input)` sends a field the endpoint ignores while the type
 * still demands it. That forced `Partial<…>` on every call and threw away the
 * check on the field you *do* have to send. It is security-relevant on the guest
 * family too: `session_token` is a bearer credential, and whether it belongs in
 * the query string or the body is exactly the distinction
 * `GuestListMessagesQuery` vs `GuestSendMessageBody` encodes.
 */
import type { InferInput, InferResponse } from "@xano/sdk";
import type { authenticatedQueries } from "./authenticated.js";
import type { guestQueries } from "./guest.js";

/** The authenticated family's handles, as types. Builds nothing. */
type Auth = ReturnType<typeof authenticatedQueries>;
/** The guest family's handles, as types. Builds nothing. */
type Guest = ReturnType<typeof guestQueries>;

/** The path parameter every per-thread route carries. */
type Thread = "conversation_id";

// ════════════════════════════════════════════════════════════════════════════
// Authenticated family — `Authorization: Bearer <token>` for `authTable`
// ════════════════════════════════════════════════════════════════════════════

/** `POST {prefix}/conversations/create` */
export type CreateConversationInput = InferInput<Auth["createConversation"]>;
/** `POST {prefix}/conversations/create` — the JSON body (`{}` is valid). */
export type CreateConversationBody = CreateConversationInput;
/** `POST {prefix}/conversations/create` */
export type CreateConversationResponse = InferResponse<Auth["createConversation"]>;

/** `GET {prefix}/conversations` — takes nothing. */
export type ListConversationsResponse = InferResponse<Auth["listConversations"]>;

/** `GET {prefix}/conversations/{conversation_id}/messages` */
export type ListMessagesInput = InferInput<Auth["listMessages"]>;
/** `GET {prefix}/conversations/{conversation_id}/messages` — path parameters. */
export type ListMessagesParams = Pick<ListMessagesInput, Thread>;
/** `GET {prefix}/conversations/{conversation_id}/messages` — oldest message first. */
export type ListMessagesResponse = InferResponse<Auth["listMessages"]>;

/** `POST {prefix}/conversations/{conversation_id}/send` */
export type SendMessageInput = InferInput<Auth["sendMessage"]>;
/** `POST {prefix}/conversations/{conversation_id}/send` — path parameters. */
export type SendMessageParams = Pick<SendMessageInput, Thread>;
/** `POST {prefix}/conversations/{conversation_id}/send` — the JSON body. */
export type SendMessageBody = Omit<SendMessageInput, Thread>;
/** `POST {prefix}/conversations/{conversation_id}/send` — this is `ChatReply`. */
export type SendMessageResponse = InferResponse<Auth["sendMessage"]>;

/** `DELETE {prefix}/conversations/{conversation_id}` */
export type DeleteConversationInput = InferInput<Auth["deleteConversation"]>;
/** `DELETE {prefix}/conversations/{conversation_id}` — path parameters. */
export type DeleteConversationParams = Pick<DeleteConversationInput, Thread>;
/** `DELETE {prefix}/conversations/{conversation_id}` — returns `null`. */
export type DeleteConversationResponse = InferResponse<Auth["deleteConversation"]>;

/** `POST {prefix}/conversations/{conversation_id}/claim` — only with `{ guest: true }`. */
export type ClaimConversationInput = InferInput<NonNullable<Auth["claimConversation"]>>;
/** `POST {prefix}/conversations/{conversation_id}/claim` — path parameters. */
export type ClaimConversationParams = Pick<ClaimConversationInput, Thread>;
/** `POST {prefix}/conversations/{conversation_id}/claim` — the JSON body (carries the guest token). */
export type ClaimConversationBody = Omit<ClaimConversationInput, Thread>;
/** `POST {prefix}/conversations/{conversation_id}/claim` */
export type ClaimConversationResponse = InferResponse<NonNullable<Auth["claimConversation"]>>;

// ════════════════════════════════════════════════════════════════════════════
// Guest family — scoped by `session_token`, only with `{ guest: true }`
//
// ⚠ `session_token` is a BEARER CAPABILITY: whoever holds it can read and
// continue the thread. Where it travels is a security property, not a style
// choice — see the per-endpoint notes.
// ════════════════════════════════════════════════════════════════════════════

/** `POST {prefix}/guest/conversations/create` */
export type GuestCreateConversationInput = InferInput<Guest["createConversation"]>;
/** `POST {prefix}/guest/conversations/create` — the JSON body (`{}` is valid). */
export type GuestCreateConversationBody = GuestCreateConversationInput;
/**
 * `POST {prefix}/guest/conversations/create`
 *
 * ⚠ The only response that ever carries `session_token`. Store it as a
 * credential; anyone holding it owns the thread until it is claimed.
 */
export type GuestCreateConversationResponse = InferResponse<Guest["createConversation"]>;

/** `GET {prefix}/guest/conversations/{conversation_id}/messages` */
export type GuestListMessagesInput = InferInput<Guest["listMessages"]>;
/** `GET {prefix}/guest/conversations/{conversation_id}/messages` — path parameters. */
export type GuestListMessagesParams = Pick<GuestListMessagesInput, Thread>;
/**
 * `GET {prefix}/guest/conversations/{conversation_id}/messages` — query string.
 *
 * ⚠ A `GET` has no body, so the token rides in the URL here and will reach
 * access logs, proxies and `Referer` headers. That is why the *delete* endpoint
 * is a `POST` instead — see {@link GuestDeleteConversationBody}.
 */
export type GuestListMessagesQuery = Omit<GuestListMessagesInput, Thread>;
/** `GET {prefix}/guest/conversations/{conversation_id}/messages` */
export type GuestListMessagesResponse = InferResponse<Guest["listMessages"]>;

/** `POST {prefix}/guest/conversations/{conversation_id}/send` */
export type GuestSendMessageInput = InferInput<Guest["sendMessage"]>;
/** `POST {prefix}/guest/conversations/{conversation_id}/send` — path parameters. */
export type GuestSendMessageParams = Pick<GuestSendMessageInput, Thread>;
/** `POST {prefix}/guest/conversations/{conversation_id}/send` — the JSON body, token included. */
export type GuestSendMessageBody = Omit<GuestSendMessageInput, Thread>;
/** `POST {prefix}/guest/conversations/{conversation_id}/send` */
export type GuestSendMessageResponse = InferResponse<Guest["sendMessage"]>;

/** `POST {prefix}/guest/conversations/{conversation_id}/delete` */
export type GuestDeleteConversationInput = InferInput<Guest["deleteConversation"]>;
/** `POST {prefix}/guest/conversations/{conversation_id}/delete` — path parameters. */
export type GuestDeleteConversationParams = Pick<GuestDeleteConversationInput, Thread>;
/**
 * `POST {prefix}/guest/conversations/{conversation_id}/delete` — the JSON body.
 *
 * A `POST` rather than a `DELETE` on purpose: a `DELETE` would have to carry the
 * token in the query string, and a URL travels into access logs, proxies and
 * `Referer` headers. The body keeps the credential out of it.
 */
export type GuestDeleteConversationBody = Omit<GuestDeleteConversationInput, Thread>;
/** `POST {prefix}/guest/conversations/{conversation_id}/delete` — returns `null`. */
export type GuestDeleteConversationResponse = InferResponse<Guest["deleteConversation"]>;

// ════════════════════════════════════════════════════════════════════════════
// The endpoint map
// ════════════════════════════════════════════════════════════════════════════

/** One endpoint's complete wire contract. `never` marks a part it does not take. */
export interface ChatbotEndpoint<Verb extends string, Route extends string, Auth, Params, Query, Body, Response> {
  /** HTTP method. */
  verb: Verb;
  /** Route template, **relative to `routePrefix`** (default `"chat"`). */
  route: Route;
  /** `"token"` = `Authorization: Bearer` for `authTable`; `"session_token"` = the guest capability; `"none"` = public. */
  auth: Auth;
  /** Path parameters, interpolated into the URL. */
  params: Params;
  /** Query-string parameters. */
  query: Query;
  /** The JSON request body. */
  body: Body;
  /** The parsed JSON response. */
  response: Response;
}

/**
 * Every endpoint, keyed by the **same name as the def handle** — so
 * `bot.authenticated.sendMessage` and `ChatbotEndpoints["sendMessage"]` describe
 * one thing, and a client can be written or generated from this map alone.
 *
 * ```ts
 * type Send = ChatbotEndpoints["sendMessage"];
 * // Send["verb"]     → "POST"
 * // Send["params"]   → { conversation_id: number }
 * // Send["body"]     → { content: string }
 * // Send["response"] → ChatReply
 * ```
 *
 * Routes are relative to `routePrefix`, and the public URL is
 * `/api:<canonical>/<routePrefix>/<route>`. Get the resolved path from
 * `xanosdk routes <entry> --emit xano/routes.gen.ts` rather than concatenating it
 * by hand.
 */
export interface ChatbotEndpoints {
  createConversation: ChatbotEndpoint<
    "POST", "conversations/create", "token",
    never, never, CreateConversationBody, CreateConversationResponse
  >;
  listConversations: ChatbotEndpoint<
    "GET", "conversations", "token",
    never, never, never, ListConversationsResponse
  >;
  listMessages: ChatbotEndpoint<
    "GET", "conversations/{conversation_id}/messages", "token",
    ListMessagesParams, never, never, ListMessagesResponse
  >;
  sendMessage: ChatbotEndpoint<
    "POST", "conversations/{conversation_id}/send", "token",
    SendMessageParams, never, SendMessageBody, SendMessageResponse
  >;
  deleteConversation: ChatbotEndpoint<
    "DELETE", "conversations/{conversation_id}", "token",
    DeleteConversationParams, never, never, DeleteConversationResponse
  >;
  claimConversation: ChatbotEndpoint<
    "POST", "conversations/{conversation_id}/claim", "token",
    ClaimConversationParams, never, ClaimConversationBody, ClaimConversationResponse
  >;

  guestCreateConversation: ChatbotEndpoint<
    "POST", "guest/conversations/create", "none",
    never, never, GuestCreateConversationBody, GuestCreateConversationResponse
  >;
  guestListMessages: ChatbotEndpoint<
    "GET", "guest/conversations/{conversation_id}/messages", "session_token",
    GuestListMessagesParams, GuestListMessagesQuery, never, GuestListMessagesResponse
  >;
  guestSendMessage: ChatbotEndpoint<
    "POST", "guest/conversations/{conversation_id}/send", "session_token",
    GuestSendMessageParams, never, GuestSendMessageBody, GuestSendMessageResponse
  >;
  guestDeleteConversation: ChatbotEndpoint<
    "POST", "guest/conversations/{conversation_id}/delete", "session_token",
    GuestDeleteConversationParams, never, GuestDeleteConversationBody, GuestDeleteConversationResponse
  >;
}

/** Every endpoint name in {@link ChatbotEndpoints}. */
export type ChatbotEndpointName = keyof ChatbotEndpoints;
