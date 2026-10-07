/**
 * @xano-sdk/chatbot — a conversational AI assistant for Xano, as typed Xano SDK defs:
 * `conversation` + `conversation_message` tables, a Xano AI `agent`, the shared
 * reply function, and the chat endpoints that drive them.
 *
 * Install it, hand it the table your users live in, write a system prompt, and a
 * fresh workspace answers a message with the whole thread persisted behind it.
 *
 * ```ts
 * import { workspace } from "@xano/sdk";
 * import { registerChatbot } from "@xano-sdk/chatbot";
 * import { userTable } from "@xano-sdk/auth";
 *
 * export const bot = registerChatbot(workspace("my-app"), {
 *   authTable: userTable,
 *   llm: { type: "xano-free", systemPrompt: "You are a support agent for Acme." },
 * });
 *
 * export default bot.xano;   // the default export must be the Xano registry
 * ```
 *
 * **Nothing here imports `@xano-sdk/auth`.** `authTable` takes any `table()` handle
 * or table name, so a workspace that rolls its own auth works identically — see
 * `ChatbotOptions.authTable`.
 *
 * Unlike `@xano-sdk/auth`, the defs are **factories**, not module-level singletons,
 * because `f.tableRef` resolves its target eagerly and the auth table is a
 * per-install choice. So there is no `import { conversationTable }` — both
 * {@link registerChatbot} and {@link createChatbot} RETURN the def set, and that
 * handle is the only route to the registered defs. Export it and a frontend can
 * derive its types from it with a type-only import that erases.
 *
 * The row, request and response types below are plain types, importable directly
 * and free at runtime — see {@link ChatbotEndpoints} for the whole surface.
 */
export { createChatbot, registerChatbot } from "./register.js";
export type { Chatbot, RegisteredChatbot } from "./register.js";

export {
  resolveOptions,
  DEFAULT_SYSTEM_PROMPT,
  TOOLS_SYSTEM_PROMPT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_TRANSCRIPT_LIMIT,
  DEFAULT_NAMES,
  MESSAGES_TEMPLATE,
} from "./options.js";
export type {
  ChatbotOptions,
  ChatbotNames,
  ChatbotAuthTable,
  ChatbotLlmOptions,
  ResolvedOptions,
} from "./options.js";

/** Def factories, for callers assembling a subset by hand. */
export { conversationTable } from "./tables/conversation.js";
export { messageTable, MESSAGE_ROLES } from "./tables/message.js";
export { chatAgent } from "./agent/chat-agent.js";
export { generateReplyFn, TITLE_LENGTH } from "./functions/generate-reply.js";
export { chatbotGroup } from "./api/group.js";
export { authenticatedQueries } from "./api/authenticated.js";
export { guestQueries } from "./api/guest.js";

/**
 * Row and response types for consumers. These erase at compile time, so a
 * frontend can `import type` them without pulling any def (or its statement
 * stack) into the bundle. Pair them with each query's `getPath()`/`verb`.
 */
export { PUBLIC_CONVERSATION_FIELDS } from "./tables/conversation.js";
export type { Conversation, PublicConversation, ConversationTable } from "./tables/conversation.js";
export { PUBLIC_MESSAGE_FIELDS } from "./tables/message.js";
export type { Message, PublicMessage, MessageRole, MessageTable } from "./tables/message.js";
export type { ChatAgent } from "./agent/chat-agent.js";
export type { GenerateReplyFn } from "./functions/generate-reply.js";
export type { ChatbotGroup } from "./api/group.js";
export type { ChatReply } from "./api/types.js";

/**
 * Per-endpoint request and response types — what a client sends, and **where each
 * input travels**. Derived from the query defs, so they cannot drift from the
 * endpoints. Type-only, so they cost a browser bundle nothing.
 *
 * Names are `<HandleName><Part>`, where the handle name is the property on
 * `bot.authenticated` / `bot.guest`:
 *
 * - `…Params` — path parameters, interpolated into the URL
 * - `…Query` — query-string parameters
 * - `…Body` — the JSON body
 * - `…Input` — all of the above at once, as core derives it
 * - `…Response` — what comes back
 *
 * A part an endpoint does not take is not exported, so the existence of a name
 * answers "does this take a body?".
 *
 * ```ts
 * import type { SendMessageBody, SendMessageParams, ChatReply } from "@xano-sdk/chatbot";
 *
 * const params: SendMessageParams = { conversation_id: 42 };  // → the URL
 * const body: SendMessageBody = { content: "Hello" };         // → the JSON body
 * ```
 *
 * {@link ChatbotEndpoints} carries the same information as one map keyed by def
 * name — verb, route, auth scheme, params, query, body and response per endpoint.
 */
export type {
  // Authenticated family
  CreateConversationInput,
  CreateConversationBody,
  CreateConversationResponse,
  ListConversationsResponse,
  ListMessagesInput,
  ListMessagesParams,
  ListMessagesResponse,
  SendMessageInput,
  SendMessageParams,
  SendMessageBody,
  SendMessageResponse,
  DeleteConversationInput,
  DeleteConversationParams,
  DeleteConversationResponse,
  ClaimConversationInput,
  ClaimConversationParams,
  ClaimConversationBody,
  ClaimConversationResponse,
  // Guest family
  GuestCreateConversationInput,
  GuestCreateConversationBody,
  GuestCreateConversationResponse,
  GuestListMessagesInput,
  GuestListMessagesParams,
  GuestListMessagesQuery,
  GuestListMessagesResponse,
  GuestSendMessageInput,
  GuestSendMessageParams,
  GuestSendMessageBody,
  GuestSendMessageResponse,
  GuestDeleteConversationInput,
  GuestDeleteConversationParams,
  GuestDeleteConversationBody,
  GuestDeleteConversationResponse,
  // The whole surface as one map, keyed by def-handle name
  ChatbotEndpoint,
  ChatbotEndpoints,
  ChatbotEndpointName,
} from "./api/client-types.js";

/**
 * Inline AI actions on records — summarise, draft a field, fill fields from pasted text — with the
 * assistant's safety rules: actions never write, model output is validated on the server, applies take
 * only allowlisted fields under the person's permission (or go through approvals), per-person rate limit
 * and a usage log. See README "AI actions".
 */
export { defineAiActions, registerAiActions, NOT_CONNECTED, MODEL_FAILED, STUB_PREFIX } from "./ai/define.js";
export type { AiActions } from "./ai/define.js";
export {
  resolveAiOptions,
  AI_ACTIONS_SYSTEM_PROMPT,
  DEFAULT_AI_RATE_LIMIT,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_PASTE_LIMIT,
  INSTRUCTION_LIMIT,
} from "./ai/options.js";
export type { AiActionsOptions, AiRecordType, AiFieldSpec, AiFieldType, AiAccess, AiRateLimit, ResolvedAiOptions } from "./ai/options.js";
export { REASONS as AI_REASONS } from "./ai/validate.js";
export { AI_CONTRACT } from "./ai/types.js";
export type {
  AiInfo, AiRecordInfo, AiFieldInfo, AiFieldKind, AiActionName, AiRunResult, AiApplyResult, AiDropped, AiUsageEntry,
} from "./ai/types.js";
