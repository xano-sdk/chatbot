/**
 * Type-level assertions. These have no runtime body worth speaking of — they pass
 * or fail at `tsc --noEmit`, which is why `npm test` runs the typecheck first.
 *
 * The point of interest is the ONE declared `responseShape`. A declaration wins
 * over derivation and core never cross-checks it against the stack, so it is a
 * hand-maintained contract. What CAN be checked is that the declared keys match
 * the keys the static walk sees — which is the half that drifts silently.
 */
import { describe, it, expect } from "vitest";
import { workspace } from "@xano/sdk";
import type { InferInput, InferResponse, StackTupleWidened } from "@xano/sdk";
import { createChatbot, registerChatbot } from "../src/index.js";
import type {
  Conversation,
  PublicConversation,
  Message,
  PublicMessage,
  MessageRole,
  ChatReply,
  SendMessageInput,
  SendMessageBody,
  SendMessageResponse,
  ListConversationsResponse,
  ListMessagesResponse,
  GuestSendMessageBody,
  GuestListMessagesQuery,
  GuestDeleteConversationBody,
  SendMessageParams,
  ChatbotEndpoints,
  ChatbotEndpointName,
} from "../src/index.js";
import { testUserTable } from "./helpers.js";

/**
 * Compile-time assertion helpers. A CALL rather than a type alias, because
 * `noUnusedLocals` flags an unused alias and every one of these would be unused
 * by construction.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
const assertType = <_T extends true>(): void => {};

const bot = createChatbot({ authTable: testUserTable, guest: true, canonical: "chat" });

describe("request types are derived and cannot drift", () => {
  it("types the send body from the def's own inputs", () => {
    type SendBody = InferInput<(typeof bot.authenticated & {})["sendMessage"]>;
    assertType<HasKey<SendBody, "conversation_id">>();
    assertType<HasKey<SendBody, "content">>();
    expect(bot.authenticated).toBeDefined();
  });

  it("types the guest send body with the session token", () => {
    type GuestBody = InferInput<(typeof bot.guest & {})["sendMessage"]>;
    assertType<HasKey<GuestBody, "session_token">>();
    assertType<HasKey<GuestBody, "content">>();
    expect(bot.guest).toBeDefined();
  });
});

describe("the one declared response shape", () => {
  it("is what a send returns", () => {
    type Sent = InferResponse<(typeof bot.authenticated & {})["sendMessage"]>;
    assertType<Equal<Sent, ChatReply>>();
    expect(true).toBe(true);
  });

  it("declares exactly reply / message_id / conversation_id / tool_calls", () => {
    // Pinning the KEYS is the part that catches a stack change the declaration
    // did not follow. The value types are the hand-maintained half.
    type Keys = keyof ChatReply;
    assertType<Equal<Keys, "conversation_id" | "reply" | "message_id" | "tool_calls">>();
    expect(true).toBe(true);
  });

  it("types reply as a string, which is an assumption about the provider", () => {
    assertType<Equal<ChatReply["reply"], string>>();
    expect(true).toBe(true);
  });
});

describe("row types", () => {
  it("narrows the public conversation projection to the returned columns", () => {
    assertType<Equal<keyof PublicConversation, "id" | "created_at" | "title" | "last_message_at">>();
    expect(true).toBe(true);
  });

  it("keeps session_token OUT of the public projection", () => {
    assertType<Equal<HasKey<PublicConversation, "session_token">, false>>();
    expect(true).toBe(true);
  });

  it("constrains a message role to the three the engine accepts", () => {
    assertType<Equal<MessageRole, "user" | "assistant" | "system">>();
    assertType<Equal<PublicMessage["role"], MessageRole>>();
    expect(true).toBe(true);
  });

  it("exposes the full row types too", () => {
    const conv: Conversation = {
      id: 1,
      created_at: 0,
      user_id: 2,
      title: "t",
      last_message_at: null,
    };
    expect(conv.id).toBe(1);
    assertType<HasKey<Message, "content">>();
  });
});

describe("options typing", () => {
  it("rejects a prompt on llm at the TYPE level AND at runtime", () => {
    expect(() =>
      // @ts-expect-error — the run prompt carries the transcript and is not the
      // caller's to set. The compile error is the primary guard (this directive
      // fails the build if the type ever stops rejecting it); the throw is the
      // backstop for a JS caller or options read from untyped config.
      createChatbot({ authTable: testUserTable, llm: { type: "xano-free", prompt: "nope" } }),
    ).toThrow(/llm\.prompt is not configurable/);
  });

  it("accepts a bare table name as authTable", () => {
    expect(() => createChatbot({ authTable: "some_table" })).not.toThrow();
  });

  it("rejects a numeric dbo.id, which cannot express a foreign key", () => {
    expect(() =>
      // @ts-expect-error — core's AuthRef allows a number; this package cannot,
      // because f.tableRef resolves through ObjectRef, which has no numeric form.
      createChatbot({ authTable: 7 }),
    ).toThrow();
  });
});

describe("getPath is typed from the route name", () => {
  it("resolves a pinned canonical", () => {
    expect(bot.authenticated!.listConversations.getPath()).toBe("/api:chat/chat/conversations");
  });

  it("types path params from the route's {markers}", () => {
    const path = bot.authenticated!.sendMessage.getPath({ params: { conversation_id: 42 } });
    expect(path).toBe("/api:chat/chat/conversations/42/send");
  });
});

describe("the exported client types match the defs they are derived from", () => {
  it("SendMessageBody drops the path param, SendMessageInput keeps it", () => {
    // The split is the whole point: `content` is the JSON body, `conversation_id`
    // travels in the URL. Without it a consumer writes `Partial<…>` and loses the
    // check on the one field they actually have to send.
    assertType<HasKey<SendMessageInput, "conversation_id">>();
    assertType<HasKey<SendMessageInput, "content">>();
    assertType<Equal<HasKey<SendMessageBody, "conversation_id">, false>>();
    assertType<HasKey<SendMessageBody, "content">>();
  });

  it("derives the same types the def handles do", () => {
    // If these ever diverge, the exported type is lying about the endpoint.
    type FromHandle = InferInput<(typeof bot.authenticated & {})["sendMessage"]>;
    assertType<Equal<SendMessageInput, FromHandle>>();

    type ListFromHandle = InferResponse<(typeof bot.authenticated & {})["listConversations"]>;
    assertType<Equal<ListConversationsResponse, ListFromHandle>>();

    expect(bot.authenticated).toBeDefined();
  });

  it("types the send response as ChatReply", () => {
    assertType<Equal<SendMessageResponse, ChatReply>>();
    expect(true).toBe(true);
  });

  it("keeps the guest body's session_token — it is not a path param", () => {
    assertType<HasKey<GuestSendMessageBody, "session_token">>();
    assertType<HasKey<GuestSendMessageBody, "content">>();
    assertType<Equal<HasKey<GuestSendMessageBody, "conversation_id">, false>>();
  });

  it("types the transcript as the public message projection", () => {
    assertType<Equal<ListMessagesResponse, PublicMessage[]>>();
    assertType<Equal<ListConversationsResponse, PublicConversation[]>>();
    expect(true).toBe(true);
  });
});

describe("no endpoint's response is widened away", () => {
  /**
   * The regression guard for the `Statement[]` widening trap.
   *
   * Spreading a helper that returns a plain `Statement[]` — or a conditional
   * `...(cond ? [x] : [])` — collapses the stack's tuple type. Every `as`/`ref()`
   * in that stack then resolves to `unknown` and the query's response infers as
   * `StackTupleWidened`. Nothing fails in this repo when that happens: the bundle
   * is byte-identical and every runtime test still passes. It surfaces only in a
   * CONSUMER's typecheck, as a response type that silently became useless.
   *
   * So assert the negative directly. `IsUseless` catches both failure modes —
   * `unknown` (which every type extends) and `StackTupleWidened`.
   */
  type IsUseless<T> = [unknown] extends [T] ? true : T extends StackTupleWidened ? true : false;

  it("keeps every authenticated response usable", () => {
    const a = bot.authenticated!;
    assertType<Equal<IsUseless<InferResponse<typeof a.createConversation>>, false>>();
    assertType<Equal<IsUseless<InferResponse<typeof a.listConversations>>, false>>();
    assertType<Equal<IsUseless<InferResponse<typeof a.listMessages>>, false>>();
    assertType<Equal<IsUseless<InferResponse<typeof a.sendMessage>>, false>>();
    expect(a.listMessages).toBeDefined();
  });

  it("keeps every guest response usable", () => {
    const g = bot.guest!;
    assertType<Equal<IsUseless<InferResponse<typeof g.createConversation>>, false>>();
    assertType<Equal<IsUseless<InferResponse<typeof g.listMessages>>, false>>();
    assertType<Equal<IsUseless<InferResponse<typeof g.sendMessage>>, false>>();
    expect(g.listMessages).toBeDefined();
  });

  it("keeps refs AFTER a spread guard resolving — the trap's real signature", () => {
    // `listMessages` binds `recent` and `messages` *after* spreading the guard.
    // Under a widened stack both resolve to `unknown`, so this is the assertion
    // that actually fails if a future refactor drops `statements(...)`.
    const a = bot.authenticated!;
    assertType<Equal<InferResponse<typeof a.listMessages>, PublicMessage[]>>();
    expect(a.listMessages.getPath({ params: { conversation_id: 1 } })).toContain("/messages");
  });
});

describe("the families are decided by the options, not always nullable", () => {
  // The usability property: `authenticated` defaults to true, so the common call
  // must not force `!` on every access. Each block below reads the family with NO
  // non-null assertion — if the conditional types regress, these stop compiling.

  it("gives a default install a present authenticated family and no guest", () => {
    const b = createChatbot({ authTable: testUserTable, canonical: "d1" });
    const send = b.authenticated.sendMessage; //    ← no `!`
    assertType<Equal<typeof b.guest, undefined>>();
    expect(send).toBeDefined();
  });

  it("gives { guest: true } both families, both non-nullable", () => {
    const b = createChatbot({ authTable: testUserTable, guest: true, canonical: "d2" });
    const send = b.authenticated.sendMessage; //    ← no `!`
    const guestSend = b.guest.sendMessage; //       ← no `!`
    const claim = b.authenticated.claimConversation;
    expect(send && guestSend).toBeDefined();
    expect(claim).toBeDefined();
  });

  it("removes the authenticated family under { authenticated: false }", () => {
    const b = createChatbot({ authenticated: false, guest: true, canonical: "d3" });
    assertType<Equal<typeof b.authenticated, undefined>>();
    const guestSend = b.guest.sendMessage; //       ← no `!`
    expect(guestSend).toBeDefined();
  });

  it("carries the same narrowing through registerChatbot", () => {
    const xano = workspace("narrowing").registerTables([testUserTable]);
    const bot = registerChatbot(xano, { authTable: testUserTable, canonical: "d4" });
    const send = bot.authenticated.sendMessage; //  ← no `!`
    assertType<Equal<typeof bot.guest, undefined>>();
    expect(bot.xano).toBe(xano);
    expect(send).toBeDefined();
  });

  it("falls back to nullable for a flag it cannot read at compile time", () => {
    // Honest degradation: a runtime boolean is genuinely unknowable, so the type
    // widens back rather than lying. This is the ONLY case still needing a check.
    const enabled: boolean = Math.random() > 0.5;
    const b = createChatbot({ authTable: testUserTable, guest: enabled, canonical: "d5" });
    assertType<Equal<undefined extends typeof b.guest ? true : false, true>>();
    expect(b).toBeDefined();
  });

  it("still rejects llm.prompt — now as a real type error, not an EPC", () => {
    expect(() =>
      // @ts-expect-error — `prompt`/`messages` are `?: never`, so this fails
      // assignability even through the generic options parameter. Omission alone
      // would only be an excess-property check, which generic inference skips.
      createChatbot({ authTable: testUserTable, llm: { type: "xano-free", prompt: "nope" } }),
    ).toThrow(/llm\.prompt is not configurable/);
  });
});

describe("the endpoint map is keyed by def name and matches the defs", () => {
  /**
   * The map is hand-written (verbs and routes are literals), so the risk is that
   * it drifts from the defs it describes. These assertions tie each entry back to
   * the real handle, so a changed input or verb breaks the build here.
   */
  it("keys the map with exactly the def-handle names", () => {
    const a = bot.authenticated;
    const g = bot.guest;
    const handleNames = [...Object.keys(a), ...Object.keys(g).map((k) => `guest${k[0]!.toUpperCase()}${k.slice(1)}`)]
      .filter((k) => k !== "all" && k !== "guestAll")
      .sort();
    const mapNames: ChatbotEndpointName[] = [
      "claimConversation", "createConversation", "deleteConversation",
      "guestCreateConversation", "guestDeleteConversation", "guestListMessages", "guestSendMessage",
      "listConversations", "listMessages", "sendMessage",
    ];
    expect(handleNames).toEqual([...mapNames].sort());
  });

  it("records the verb each def actually declares", () => {
    const a = bot.authenticated;
    const g = bot.guest;
    // The map's literal verbs, checked against the defs at runtime.
    expect(a.sendMessage.verb).toBe("POST");
    expect(a.listConversations.verb).toBe("GET");
    expect(a.listMessages.verb).toBe("GET");
    expect(a.deleteConversation.verb).toBe("DELETE");
    expect(g.listMessages.verb).toBe("GET");
    // A POST, not a DELETE — so the bearer token stays out of the URL.
    expect(g.deleteConversation.verb).toBe("POST");

    assertType<Equal<ChatbotEndpoints["sendMessage"]["verb"], "POST">>();
    assertType<Equal<ChatbotEndpoints["deleteConversation"]["verb"], "DELETE">>();
    assertType<Equal<ChatbotEndpoints["guestDeleteConversation"]["verb"], "POST">>();
  });

  it("splits params / query / body so every input has exactly one home", () => {
    // Authenticated send: id in the path, content in the body.
    assertType<Equal<ChatbotEndpoints["sendMessage"]["params"], SendMessageParams>>();
    assertType<Equal<ChatbotEndpoints["sendMessage"]["body"], SendMessageBody>>();
    assertType<Equal<ChatbotEndpoints["sendMessage"]["query"], never>>();
    assertType<Equal<HasKey<SendMessageParams, "conversation_id">, true>>();
    assertType<Equal<HasKey<SendMessageBody, "conversation_id">, false>>();

    // Params ∪ Body must reconstruct exactly what core derives — nothing lost,
    // nothing invented.
    assertType<Equal<SendMessageParams & SendMessageBody extends SendMessageInput ? true : false, true>>();
    assertType<Equal<HasKey<SendMessageInput, "content">, true>>();
  });

  it("puts the guest token in the query string on GET and the body on POST", () => {
    // The security-relevant distinction, pinned. A GET has no body, so the token
    // rides in the URL; the delete is a POST precisely to avoid that.
    assertType<Equal<HasKey<GuestListMessagesQuery, "session_token">, true>>();
    assertType<Equal<ChatbotEndpoints["guestListMessages"]["body"], never>>();

    assertType<Equal<HasKey<GuestDeleteConversationBody, "session_token">, true>>();
    assertType<Equal<ChatbotEndpoints["guestDeleteConversation"]["query"], never>>();

    assertType<Equal<HasKey<GuestSendMessageBody, "session_token">, true>>();
    assertType<Equal<ChatbotEndpoints["guestSendMessage"]["query"], never>>();
  });

  it("labels the auth scheme per endpoint", () => {
    assertType<Equal<ChatbotEndpoints["sendMessage"]["auth"], "token">>();
    assertType<Equal<ChatbotEndpoints["guestSendMessage"]["auth"], "session_token">>();
    // Creating a guest thread is the one genuinely public endpoint — it is what
    // MINTS the token, so it cannot require one.
    assertType<Equal<ChatbotEndpoints["guestCreateConversation"]["auth"], "none">>();
    expect(true).toBe(true);
  });

  it("records routes that match the defs' names under the default prefix", () => {
    const a = bot.authenticated;
    const g = bot.guest;
    // `route` is relative to routePrefix; the def's name is prefixed with it.
    expect(a.sendMessage.name).toBe("chat/conversations/{conversation_id}/send");
    expect(g.listMessages.name).toBe("chat/guest/conversations/{conversation_id}/messages");
    assertType<Equal<ChatbotEndpoints["sendMessage"]["route"], "conversations/{conversation_id}/send">>();
    assertType<
      Equal<ChatbotEndpoints["guestListMessages"]["route"], "guest/conversations/{conversation_id}/messages">
    >();
  });
});
