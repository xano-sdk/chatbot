/**
 * `resolveOptions` — the single validation gate. Every check lives there so a bad
 * call fails before any def is built, rather than half-way through a workspace or
 * as an opaque throw from core's encoder.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOptions,
  createChatbot,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_TRANSCRIPT_LIMIT,
  MESSAGES_TEMPLATE,
} from "../src/index.js";
import { testUserTable } from "./helpers.js";

describe("authTable", () => {
  it("is required when the authenticated family is on (the default)", () => {
    expect(() => resolveOptions({})).toThrow(/`authTable` is required/);
  });

  it("names the anonymous-only escape in the error, since that is the other valid shape", () => {
    expect(() => resolveOptions({})).toThrow(/authenticated: false, guest: true/);
  });

  it("says the value was undefined, not missing, when authTable is passed but evaluates to undefined", () => {
    // `{ authTable: userTable }` where `userTable` is undefined at call time — a
    // circular import or a wrong import name. "Pass authTable" would be wrong advice.
    expect(() => resolveOptions({ authTable: undefined })).toThrow(/`authTable` was passed but is undefined/);
    expect(() => resolveOptions({ authTable: undefined })).toThrow(/circular import/);
    expect(() => resolveOptions({ authTable: undefined })).not.toThrow(/is required/);
  });

  it("is NOT required for a guest-only install", () => {
    expect(() => resolveOptions({ authenticated: false, guest: true })).not.toThrow();
  });

  it("accepts a def handle", () => {
    expect(resolveOptions({ authTable: testUserTable }).authTable).toBe(testUserTable);
  });

  it("accepts a bare table name — the roll-your-own path", () => {
    expect(resolveOptions({ authTable: "my_members" }).authTable).toBe("my_members");
  });
});

describe("family selection", () => {
  it("refuses an install with neither family, which would be unreachable defs", () => {
    expect(() => resolveOptions({ authenticated: false, guest: false })).toThrow(
      /both endpoint families are disabled/,
    );
  });

  it("defaults to authenticated-only", () => {
    const o = resolveOptions({ authTable: testUserTable });
    expect(o.authenticated).toBe(true);
    expect(o.guest).toBe(false);
  });
});

describe("the run prompt is not the caller's to set", () => {
  // Core stores ONE prompt behind a `prompt_type` discriminator, so a supplied
  // prompt would REPLACE the transcript rather than add to it. Silent history loss
  // is exactly what core's own `prompt` XOR `messages` union exists to prevent;
  // this keeps that guarantee from being reintroduced one level up.
  it("rejects llm.prompt", () => {
    expect(() => resolveOptions({ authTable: testUserTable, llm: { type: "xano-free", prompt: "hi" } as any })).toThrow(
      /llm\.prompt is not configurable/,
    );
  });

  it("rejects llm.messages", () => {
    expect(() =>
      resolveOptions({ authTable: testUserTable, llm: { type: "xano-free", messages: "[]" } as any }),
    ).toThrow(/llm\.messages is not configurable/);
  });

  it("points the caller at systemPrompt instead", () => {
    expect(() => resolveOptions({ authTable: testUserTable, llm: { prompt: "x" } as any })).toThrow(
      /systemPrompt/,
    );
  });

  it("always pins the messages template", () => {
    const o = resolveOptions({ authTable: testUserTable, llm: { type: "anthropic", model: "x" } as any });
    expect((o.llm as any).messages).toBe(MESSAGES_TEMPLATE);
  });

  it("an explicitly undefined prompt is not a supplied prompt", () => {
    // A merged options object can carry the key with no value; that is not the
    // mistake the guard is for.
    expect(() =>
      resolveOptions({ authTable: testUserTable, llm: { type: "xano-free", prompt: undefined } as any }),
    ).not.toThrow();
  });
});

describe("llm defaults", () => {
  it("defaults to the keyless xano-free provider, so a fresh install answers with no credential", () => {
    expect(resolveOptions({ authTable: testUserTable }).llm.type).toBe("xano-free");
  });

  it("defaults the system prompt and lets the caller replace it", () => {
    expect((resolveOptions({ authTable: testUserTable }).llm as any).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    const custom = resolveOptions({
      authTable: testUserTable,
      llm: { type: "xano-free", systemPrompt: "Be Acme's support agent." },
    });
    expect((custom.llm as any).systemPrompt).toBe("Be Acme's support agent.");
  });

  it("asks the model for markdown, which is the half that makes rendering work", () => {
    // Paired with the README's "render the reply as Markdown" guidance. The
    // golden fixture supplies its OWN systemPrompt, so it does not cover the
    // default — this is the only thing standing between a refactor and a silent
    // regression to plain-text replies.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/markdown/i);
  });

  it("asks for LIGHT markdown, not headings and tables in a two-line answer", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/light/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/no headings or tables/i);
  });

  it("tells the model not to emit raw HTML", () => {
    // A nudge, not a control — the renderer is the control (see ChatReply.reply).
    // Still worth pinning: it is free, and it lowers the rate at which a
    // prompt-injection attempt produces markup a sloppy frontend would inject.
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/raw HTML/i);
  });

  it("passes provider fields through", () => {
    const o = resolveOptions({
      authTable: testUserTable,
      llm: { type: "anthropic", model: "claude-opus-5", temperature: 0.2 } as any,
    });
    expect(o.llm.type).toBe("anthropic");
    expect((o.llm as any).model).toBe("claude-opus-5");
  });
});

describe("limits", () => {
  it("default to the documented values", () => {
    const o = resolveOptions({ authTable: testUserTable });
    expect(o.historyLimit).toBe(DEFAULT_HISTORY_LIMIT);
    expect(o.listLimit).toBe(DEFAULT_LIST_LIMIT);
    expect(o.transcriptLimit).toBe(DEFAULT_TRANSCRIPT_LIMIT);
  });

  for (const field of ["historyLimit", "listLimit", "transcriptLimit"] as const) {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      it(`rejects ${field}: ${bad}`, () => {
        expect(() => resolveOptions({ authTable: testUserTable, [field]: bad })).toThrow(
          new RegExp(`${field} .* is not valid`),
        );
      });
    }
  }

  it("reports NaN as NaN rather than JSON.stringify's null", () => {
    expect(() => resolveOptions({ authTable: testUserTable, historyLimit: Number.NaN })).toThrow(/NaN/);
  });
});

describe("canonical", () => {
  it("is unset by default, deferring identity to the consumer's lock", () => {
    expect(resolveOptions({ authTable: testUserTable }).canonical).toBeUndefined();
  });

  it("accepts a url-safe segment", () => {
    expect(resolveOptions({ authTable: testUserTable, canonical: "chat-v1_2" }).canonical).toBe("chat-v1_2");
  });

  for (const bad of ["", "has space", "sla/sh", "punct!", 7 as any, null as any]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => resolveOptions({ authTable: testUserTable, canonical: bad })).toThrow(
        /is not a valid URL segment/,
      );
    });
  }
});

describe("history", () => {
  it("defaults OFF, unlike the engine — request bodies carry message text and guest tokens", () => {
    expect(resolveOptions({ authTable: testUserTable }).history).toBe(false);
  });

  for (const ok of [true, false, 25, "all" as const]) {
    it(`accepts ${JSON.stringify(ok)}`, () => {
      expect(resolveOptions({ authTable: testUserTable, history: ok }).history).toBe(ok);
    });
  }

  for (const bad of [0, -5, 1.5, "some" as any, {} as any]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => resolveOptions({ authTable: testUserTable, history: bad })).toThrow(
        /is not a valid setting/,
      );
    });
  }
});

describe("userIdType", () => {
  it("defaults to int", () => {
    expect(resolveOptions({ authTable: testUserTable }).userIdType).toBe("int");
  });

  it("accepts uuid", () => {
    expect(resolveOptions({ authTable: "u", userIdType: "uuid" }).userIdType).toBe("uuid");
  });

  it("rejects anything else — Xano has no other primary-key type", () => {
    expect(() => resolveOptions({ authTable: "u", userIdType: "text" as any })).toThrow(/is not valid/);
  });
});

describe("routePrefix", () => {
  it("defaults to `chat`", () => {
    expect(resolveOptions({ authTable: testUserTable }).routePrefix).toBe("chat");
  });

  it("accepts a nested prefix", () => {
    expect(resolveOptions({ authTable: testUserTable, routePrefix: "support/chat" }).routePrefix).toBe(
      "support/chat",
    );
  });

  for (const bad of ["", "/lead", "trail/", "has space", "{param}", "pun!ct", 7 as any]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => resolveOptions({ authTable: testUserTable, routePrefix: bad })).toThrow(
        /routePrefix .* is not valid/,
      );
    });
  }

  it("rejects a {param} marker — a prefix is not a place for a path param", () => {
    expect(() => resolveOptions({ authTable: testUserTable, routePrefix: "a/{id}" })).toThrow(
      /path param/,
    );
  });
});

describe("names", () => {
  it("default, and merge per-key rather than replacing the whole map", () => {
    const o = resolveOptions({ authTable: testUserTable, names: { message: "chat_turn" } });
    expect(o.names.message).toBe("chat_turn");
    expect(o.names.conversation).toBe("conversation");
    expect(o.names.agent).toBe("chatbot_agent");
  });

  it("defaults the message table to a namespaced name, not a bare `message`", () => {
    // A bare `message` is a name a realtime or notification workspace plausibly
    // already holds, and the collision would surface as a duplicate-guid throw.
    expect(resolveOptions({ authTable: testUserTable }).names.message).toBe("conversation_message");
  });
});

describe("no shared state between calls", () => {
  // The property that lets this package skip @xano-sdk/auth's ~100 lines of
  // cross-call conflict guards: nothing is a module singleton.
  it("two createChatbot calls produce independent defs", () => {
    const a = createChatbot({ authTable: testUserTable, canonical: "one" });
    const b = createChatbot({ authTable: testUserTable, canonical: "two" });
    expect(a.group).not.toBe(b.group);
    expect(a.group.canonical).toBe("one");
    expect(b.group.canonical).toBe("two");
  });

  it("a second call with a different canonical does not retroactively change the first", () => {
    const a = createChatbot({ authTable: testUserTable, canonical: "first" });
    createChatbot({ authTable: testUserTable, canonical: "second" });
    expect(a.group.canonical).toBe("first");
  });
});

describe("rateLimit validation", () => {
  it("defaults to 20 per 60s", () => {
    expect(resolveOptions({ authTable: testUserTable }).rateLimit).toEqual({
      max: 20,
      ttl: 60,
      error: "Too many messages. Please wait a moment and try again.",
    });
  });

  it("accepts false", () => {
    expect(resolveOptions({ authTable: testUserTable, rateLimit: false }).rateLimit).toBe(false);
  });

  for (const bad of [0, -1, 1.5, NaN]) {
    it(`rejects max ${bad}`, () => {
      expect(() => resolveOptions({ authTable: testUserTable, rateLimit: { max: bad } })).toThrow(/rateLimit\.max/);
    });
    it(`rejects ttl ${bad}`, () => {
      expect(() => resolveOptions({ authTable: testUserTable, rateLimit: { ttl: bad } })).toThrow(/rateLimit\.ttl/);
    });
  }

  it("rejects an empty error message", () => {
    expect(() => resolveOptions({ authTable: testUserTable, rateLimit: { error: "" } })).toThrow(/rateLimit\.error/);
  });
})
