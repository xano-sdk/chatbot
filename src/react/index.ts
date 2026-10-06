/**
 * @xano-sdk/chatbot/react — the OPTIONAL React frontend: what a complete assistant looks like.
 *
 * Self-contained (no imports from your app, no Markdown or icon packages), styled with shadcn/ui's theme
 * tokens so it matches a shadcn/Tailwind app, light and dark. Use it as is, or read it as the reference
 * for your own (README "Building a frontend").
 *
 *   const chatClient = createChatClient({ apiBaseUrl: `${XANO_HOST}/api:chat`, getToken: () => session.token });
 *   <Chat client={chatClient} assistantName="Desk assistant" suggestions={["Summarise my queue"]} />   // a page
 *   <ChatWidget client={chatClient} assistantName="Acme help" />                                       // a corner launcher
 */
export { createChatClient, ChatError, describeChatError } from "./client.js";
export type { ChatClient, ChatClientOptions, ChatReply, PublicConversation, PublicMessage } from "./client.js";
export { useChat } from "./use-chat.js";
export type { ChatState, ChatTurn, ChatProblem, UseChatOptions } from "./use-chat.js";
export { Chat } from "./chat.js";
export { ChatWidget, openChatWidget } from "./widget.js";
export type { ChatWidgetSize } from "./widget.js";
export { Thread } from "./thread.js";
export type { ThreadText } from "./thread.js";
export { Markdown } from "./markdown.js";
