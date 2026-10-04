/**
 * Table encoding. The two assertions that matter most here are the ones guarding
 * a LIVE failure mode rather than a shape preference — `role`'s enum and
 * `content`'s `min:1`, both of which exist because the engine's `messages`
 * decoding is strict and one of its two failure modes is silent (see
 * `src/tables/message.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  exportWith,
  tableRow,
  column,
  guidFor,
  testUserTable,
  uuidUserTable,
  membersTable,
  section,
} from "./helpers.js";
import { MESSAGE_ROLES } from "../src/index.js";

describe("conversation", () => {
  it("references the caller's auth table by its derived guid", () => {
    const conv = tableRow(exportWith(), "conversation");
    const userId = column(conv, "user_id");
    expect(userId.methods).toEqual([
      { name: "@", disabled: false, arg: [`dbo=${guidFor.table("test_user")}`] },
    ]);
  });

  it("points at whatever table it was handed, not a hard-coded `user`", () => {
    // The whole reason the defs are factories. A different auth table must move
    // the foreign key with it. Referenced by BARE NAME here, which is the
    // roll-your-own path — and the table still has to be registered, because core
    // treats an unregistered auth reference as an export error, not a warning.
    const payload = exportWith({ authTable: "members" }, { extraTables: [membersTable] });
    const conv = tableRow(payload, "conversation");
    expect(column(conv, "user_id").methods[0].arg).toEqual([`dbo=${guidFor.table("members")}`]);
  });

  it("follows a uuid-keyed auth table's primary-key type", () => {
    const conv = tableRow(exportWith({ authTable: uuidUserTable, userIdType: "uuid" }), "conversation");
    expect(column(conv, "user_id").type).toBe("uuid");
  });

  it("omits user_id entirely on a guest-only install", () => {
    // A nullable FK to nothing is worse than no column: it would still emit an
    // `@` method carrying a guid resolving to no registered table.
    const conv = tableRow(exportWith({ authenticated: false, guest: true }), "conversation");
    expect(column(conv, "user_id")).toBeUndefined();
    expect(column(conv, "session_token")).toBeDefined();
  });

  it("omits session_token unless guests are enabled", () => {
    const conv = tableRow(exportWith(), "conversation");
    expect(column(conv, "session_token")).toBeUndefined();
  });

  it("makes user_id nullable only when a guest thread could exist unclaimed", () => {
    expect(column(tableRow(exportWith({ guest: true }), "conversation"), "user_id").nullable).toBe(true);
    // Authenticated-only: every row is created by an endpoint that fills it in.
    expect(column(tableRow(exportWith(), "conversation"), "user_id").nullable).toBe(false);
  });

  it("keeps session_token internal so a stray read cannot leak another thread's capability", () => {
    const conv = tableRow(exportWith({ guest: true }), "conversation");
    expect(column(conv, "session_token").access).toBe("internal");
  });

  it("indexes session_token UNIQUE — one token must address exactly one thread", () => {
    const conv = tableRow(exportWith({ guest: true }), "conversation");
    const unique = conv.index.filter((i: any) => i.type === "btree|unique");
    expect(unique).toHaveLength(1);
    expect(unique[0].fields).toEqual([{ name: "session_token", op: "asc" }]);
  });

  it("indexes user_id — the list endpoint's access path", () => {
    const conv = tableRow(exportWith(), "conversation");
    const onUser = conv.index.filter(
      (i: any) => i.type === "btree" && i.fields.some((f: any) => f.name === "user_id"),
    );
    expect(onUser).toHaveLength(1);
  });

  it("pins useXdo rather than inheriting the consumer workspace's setting", () => {
    // Left unset, the storage mode — and so the emitted bytes — would depend on
    // who installed the package.
    const conv = tableRow(exportWith(), "conversation");
    expect(conv.index.some((i: any) => i.type === "gin")).toBe(true);
  });

  it("is not an auth table itself", () => {
    expect(tableRow(exportWith(), "conversation").auth).toBe(false);
  });
});

describe("conversation_message", () => {
  it("constrains role to an enum, making the fatal unknown-role state unstorable", () => {
    // Verified live: a role outside the provider's set makes the agent run fail
    // with ERROR_FATAL on the NEXT send — a different request from the one that
    // wrote the row. The database is the only place that can prevent it.
    const msg = tableRow(exportWith(), "conversation_message");
    const role = column(msg, "role");
    expect(role.type).toBe("enum");
    expect(role.required).toBe(true);
    expect(role.values).toEqual([...MESSAGE_ROLES]);
  });

  it("exposes exactly the three roles the engine accepts", () => {
    expect(MESSAGE_ROLES).toEqual(["user", "assistant", "system"]);
  });

  it("requires non-empty content, because an empty turn does not error — it hallucinates", () => {
    // Verified live: a blank `content` produced a reply inventing an entire
    // fictional prior exchange. `min:1` is the guard against a confabulation
    // entering the transcript and poisoning every later turn's context.
    const msg = tableRow(exportWith(), "conversation_message");
    const content = column(msg, "content");
    expect(content.required).toBe(true);
    expect(content.methods).toEqual([{ name: "min", disabled: false, arg: [1] }]);
  });

  it("references the conversation table by def handle, not name", () => {
    const msg = tableRow(exportWith(), "conversation_message");
    expect(column(msg, "conversation_id").methods[0].arg).toEqual([
      `dbo=${guidFor.table("conversation")}`,
    ]);
  });

  it("follows a renamed conversation table", () => {
    const payload = exportWith({ names: { conversation: "thread" } });
    const msg = tableRow(payload, "conversation_message");
    expect(column(msg, "conversation_id").methods[0].arg).toEqual([`dbo=${guidFor.table("thread")}`]);
  });

  it("indexes (conversation_id, created_at) so a transcript read is served by the index", () => {
    const msg = tableRow(exportWith(), "conversation_message");
    const composite = msg.index.find(
      (i: any) => i.fields.length === 2 && i.fields[0].name === "conversation_id",
    );
    expect(composite.fields).toEqual([
      { name: "conversation_id", op: "asc" },
      { name: "created_at", op: "asc" },
    ]);
  });
});

describe("naming", () => {
  it("honours name overrides across every kind", () => {
    const payload = exportWith({
      guest: true,
      names: {
        conversation: "thread",
        message: "turn",
        agent: "helper",
        apiGroup: "Assistant",
        replyFn: "bot/reply",
      },
    });
    expect(section(payload, "dbo").map((t) => t.name)).toContain("thread");
    expect(section(payload, "dbo").map((t) => t.name)).toContain("turn");
    expect(section(payload, "toolset").map((t) => t.name)).toEqual(["helper"]);
    expect(section(payload, "app").map((a) => a.name)).toEqual(["Assistant"]);
    expect(section(payload, "function").map((f) => f.name)).toEqual(["bot/reply"]);
  });

  it("tags every def it creates", () => {
    const payload = exportWith({ guest: true, tags: ["acme:chat"] });
    const tagged = [
      ...section(payload, "dbo").filter((t) => t.name !== "test_user"),
      ...section(payload, "function"),
      ...section(payload, "toolset"),
      ...section(payload, "app"),
      ...section(payload, "query"),
    ];
    for (const row of tagged) {
      expect(row.tag, row.name).toEqual([{ tag: "acme:chat" }]);
    }
  });
});

describe("identity", () => {
  it("pins no guids — every one is the name derivation", () => {
    // Identity belongs to the consumer's xano.lock. A hard-coded guid here would
    // take that away and break a re-import into a locked workspace.
    const payload = exportWith({ guest: true });
    expect(tableRow(payload, "conversation").guid).toBe(guidFor.table("conversation"));
    expect(tableRow(payload, "conversation_message").guid).toBe(guidFor.table("conversation_message"));
    expect(section(payload, "toolset")[0].guid).toBe(guidFor.toolset("chatbot_agent"));
    expect(section(payload, "function")[0].guid).toBe(guidFor.fn("chatbot/generate_reply"));
    expect(section(payload, "app")[0].guid).toBe(guidFor.group("Chatbot"));
  });

  it("pins no canonical by default", () => {
    expect(section(exportWith(), "app")[0].canonical).toBe("");
  });

  it("uses the auth table handle rather than assuming its name", () => {
    expect(column(tableRow(exportWith(), "conversation"), "user_id").methods[0].arg[0]).toContain(
      guidFor.table(testUserTable.name),
    );
  });
});
