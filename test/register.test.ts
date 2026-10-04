/**
 * `createChatbot` / `registerChatbot`.
 *
 * The theme is what this package deliberately does NOT have: no module
 * singletons, so no idempotency WeakSet and no cross-call agreement guards. The
 * tests below pin that absence as a property rather than an omission.
 */
import { describe, it, expect } from "vitest";
import { Xano } from "@xano/sdk";
import { createChatbot, registerChatbot } from "../src/index.js";
import { testUserTable, exportWith, section, membersTable } from "./helpers.js";

const fresh = () => new Xano().registerWorkspace({ name: "reg-test" }).registerTables([testUserTable]);

describe("createChatbot", () => {
  it("returns every def plus the resolved options", () => {
    const bot = createChatbot({ authTable: testUserTable, guest: true });
    expect(bot.conversation).toBeDefined();
    expect(bot.message).toBeDefined();
    expect(bot.agent).toBeDefined();
    expect(bot.replyFn).toBeDefined();
    expect(bot.group).toBeDefined();
    expect(bot.authenticated).toBeDefined();
    expect(bot.guest).toBeDefined();
    expect(bot.options.historyLimit).toBe(20);
  });

  it("registers nothing by itself", () => {
    const xano = fresh();
    createChatbot({ authTable: testUserTable });
    // Only the auth table registered above.
    expect(section((xano.export() as any).payload, "dbo").map((t) => t.name)).toEqual(["test_user"]);
  });

  it("omits the family that is switched off", () => {
    expect(createChatbot({ authenticated: false, guest: true }).authenticated).toBeUndefined();
    expect(createChatbot({ authTable: testUserTable }).guest).toBeUndefined();
  });

  it("collects both families into `queries`", () => {
    expect(createChatbot({ authTable: testUserTable, guest: true }).queries).toHaveLength(10);
    expect(createChatbot({ authTable: testUserTable }).queries).toHaveLength(5);
    expect(createChatbot({ authenticated: false, guest: true }).queries).toHaveLength(4);
  });
});

describe("registerChatbot", () => {
  it("registers every kind", () => {
    const payload = exportWith({ guest: true });
    expect(section(payload, "dbo").map((t) => t.name)).toEqual([
      "test_user",
      "conversation",
      "conversation_message",
    ]);
    expect(section(payload, "function")).toHaveLength(1);
    expect(section(payload, "toolset")).toHaveLength(1);
    expect(section(payload, "app")).toHaveLength(1);
    expect(section(payload, "query")).toHaveLength(10);
  });

  it("returns the def set, carrying the instance on `.xano`", () => {
    // The handle is the ONLY route a consumer has to the registered defs — the
    // defs are factories, so there is no module-level export to reach for. A
    // frontend deriving its request/response types depends on this.
    const xano = fresh();
    const bot = registerChatbot(xano, { authTable: testUserTable });

    expect(bot.xano).toBe(xano);
    expect(bot.conversation).toBeDefined();
    expect(bot.message).toBeDefined();
    expect(bot.agent).toBeDefined();
    expect(bot.replyFn).toBeDefined();
    expect(bot.group).toBeDefined();
    expect(bot.authenticated?.sendMessage).toBeDefined();
    expect(bot.guest).toBeUndefined();
    expect(bot.queries).toHaveLength(5);
  });

  it("hands back the same defs it registered, not a second set", () => {
    // `{ ...bot, xano }` must spread the ALREADY-REGISTERED set. Rebuilding here
    // would hand the consumer defs the workspace does not hold — identical by
    // name, distinct by identity, and silently wrong to reference from a stack.
    const xano = fresh();
    const bot = registerChatbot(xano, { authTable: testUserTable });
    const payload = (xano.export() as any).payload;

    const registeredQueryNames = section(payload, "query").map((q: any) => q.name).sort();
    const handleQueryNames = bot.queries.map((q) => q.name).sort();
    expect(handleQueryNames).toEqual(registeredQueryNames);

    expect(section(payload, "dbo").map((t: any) => t.name)).toContain(bot.conversation.name);
    expect(section(payload, "dbo").map((t: any) => t.name)).toContain(bot.message.name);
  });

  it("never registers the auth table it was handed", () => {
    // It only REFERENCES it. Registering it too would collide with the consumer's
    // own registration (or registerAuth's) via core's duplicate-def guard — which
    // is exactly what makes `registerAuth(x); registerChatbot(x)` work.
    const xano = fresh(); // already holds test_user
    registerChatbot(xano, { authTable: testUserTable });
    const names = section((xano.export() as any).payload, "dbo").map((t) => t.name);
    expect(names.filter((n) => n === "test_user")).toHaveLength(1);
  });

  it("works when the auth table is registered AFTER it", () => {
    // References resolve through name-derived guids, so registration order is not
    // a constraint — which is what lets a consumer call registerAuth either side.
    const xano = new Xano().registerWorkspace({ name: "order" });
    registerChatbot(xano, { authTable: testUserTable });
    xano.registerTables([testUserTable]);
    expect(() => xano.export()).not.toThrow();
  });
});

describe("no shared state — the reason there are no conflict guards", () => {
  it("two registrations into two workspaces do not interfere", () => {
    const a = new Xano().registerWorkspace({ name: "ws-a" }).registerTables([testUserTable]);
    const b = new Xano().registerWorkspace({ name: "ws-b" }).registerTables([membersTable]);
    registerChatbot(a, { authTable: testUserTable, canonical: "alpha" });
    registerChatbot(b, { authTable: membersTable, canonical: "beta" });

    expect(section((a.export() as any).payload, "app")[0].canonical).toBe("alpha");
    expect(section((b.export() as any).payload, "app")[0].canonical).toBe("beta");
  });

  it("a second registration cannot retarget the first workspace's group", () => {
    // This is the exact failure @xano-sdk/auth's registerAuth throws to prevent,
    // because its group is a process-wide singleton. Here it is impossible.
    const a = new Xano().registerWorkspace({ name: "ws-1" }).registerTables([testUserTable]);
    registerChatbot(a, { authTable: testUserTable, canonical: "keepme" });
    const before = section((a.export() as any).payload, "app")[0].canonical;

    const b = new Xano().registerWorkspace({ name: "ws-2" }).registerTables([membersTable]);
    registerChatbot(b, { authTable: membersTable, canonical: "different" });

    expect(section((a.export() as any).payload, "app")[0].canonical).toBe(before);
  });

  it("omitting canonical on a later call does not inherit an earlier one", () => {
    const a = new Xano().registerWorkspace({ name: "ws-3" }).registerTables([testUserTable]);
    registerChatbot(a, { authTable: testUserTable, canonical: "pinned" });

    const b = new Xano().registerWorkspace({ name: "ws-4" }).registerTables([membersTable]);
    registerChatbot(b, { authTable: membersTable });
    expect(section((b.export() as any).payload, "app")[0].canonical).toBe("");
  });

  it("differing history settings coexist", () => {
    const a = new Xano().registerWorkspace({ name: "ws-5" }).registerTables([testUserTable]);
    const b = new Xano().registerWorkspace({ name: "ws-6" }).registerTables([membersTable]);
    registerChatbot(a, { authTable: testUserTable });
    registerChatbot(b, { authTable: membersTable, history: true });
    expect(section((a.export() as any).payload, "app")[0].history.query_enabled).toBe(false);
    expect(section((b.export() as any).payload, "app")[0].history.query_enabled).toBe(true);
  });
});

describe("registering one set twice", () => {
  it("is caught by core's duplicate-def guard, which names the def", () => {
    const xano = fresh();
    const bot = createChatbot({ authTable: testUserTable });
    xano.registerTables([bot.conversation, bot.message]);
    expect(() => xano.registerTables([bot.conversation])).toThrow(/registered twice/);
  });

  it("a second registerChatbot on one instance throws AT THE CALL", () => {
    // Core's duplicate-def guard compares def identity, and two createChatbot
    // calls produce distinct objects sharing names — so without this package's own
    // WeakSet the mistake slips through and surfaces at export() as
    // `Duplicate object guid … shared by "dbo/conversation" and "dbo/conversation"`,
    // naming neither call.
    const xano = fresh();
    registerChatbot(xano, { authTable: testUserTable });
    expect(() => registerChatbot(xano, { authTable: testUserTable })).toThrow(
      /already called on this Xano instance/,
    );
  });

  it("points at the names option, which is how two bots DO coexist", () => {
    const xano = fresh();
    registerChatbot(xano, { authTable: testUserTable });
    expect(() => registerChatbot(xano, { authTable: testUserTable })).toThrow(/routePrefix/);
  });
});

describe("two chatbots in one workspace", () => {
  it("works when the second set is renamed — the escape the guard advertises", () => {
    const xano = fresh();
    registerChatbot(xano, { authTable: testUserTable, canonical: "chat" });

    const support = createChatbot({
      authTable: testUserTable,
      canonical: "support",
      // The prefix keeps the ENDPOINT guids apart (a query's identity is its route
      // name); `names` keeps the stored objects apart. Both are needed.
      routePrefix: "support",
      names: {
        conversation: "support_conversation",
        message: "support_message",
        agent: "support_agent",
        apiGroup: "Support",
        replyFn: "support/reply",
      },
    });
    xano
      .registerTables([support.conversation, support.message])
      .registerAgents([support.agent])
      .registerFunctions([support.replyFn])
      .registerApiGroups([support.group])
      .registerQueries(support.queries);

    const payload = (xano.export() as any).payload;
    expect(section(payload, "dbo").map((t) => t.name).sort()).toEqual([
      "conversation",
      "conversation_message",
      "support_conversation",
      "support_message",
      "test_user",
    ]);
    expect(section(payload, "app").map((a) => a.name).sort()).toEqual(["Chatbot", "Support"]);
    expect(section(payload, "toolset")).toHaveLength(2);
    // Ten routes per bot, none shared.
    const routes = section(payload, "query").map((q) => q.name);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.filter((r: string) => r.startsWith("support/"))).toHaveLength(5);
  });
});

describe("cherry-picking", () => {
  it("is the factory's return value, since there is no module-level def to import", () => {
    const xano = new Xano().registerWorkspace({ name: "cherry" }).registerTables([testUserTable]);
    const bot = createChatbot({ authTable: testUserTable });

    xano
      .registerTables([bot.conversation, bot.message])
      .registerAgents([bot.agent])
      .registerFunctions([bot.replyFn])
      .registerApiGroups([bot.group])
      // Only the send endpoint — dependencies must travel with it.
      .registerQueries([bot.authenticated!.sendMessage]);

    const payload = (xano.export() as any).payload;
    expect(section(payload, "query").map((q) => q.name)).toEqual([
      "chat/conversations/{conversation_id}/send",
    ]);
  });

  it("exposes each endpoint by name", () => {
    const bot = createChatbot({ authTable: testUserTable, guest: true });
    expect(bot.authenticated!.createConversation).toBeDefined();
    expect(bot.authenticated!.listConversations).toBeDefined();
    expect(bot.authenticated!.listMessages).toBeDefined();
    expect(bot.authenticated!.sendMessage).toBeDefined();
    expect(bot.authenticated!.deleteConversation).toBeDefined();
    expect(bot.authenticated!.claimConversation).toBeDefined();
    expect(bot.guest!.createConversation).toBeDefined();
  });

  it("leaves claimConversation undefined without guests", () => {
    expect(createChatbot({ authTable: testUserTable }).authenticated!.claimConversation).toBeUndefined();
  });
});

describe("getPath", () => {
  it("resolves without a lock once a canonical is pinned", () => {
    const bot = createChatbot({ authTable: testUserTable, canonical: "chat" });
    expect(bot.authenticated!.listConversations.getPath()).toBe("/api:chat/chat/conversations");
  });

  it("throws when nothing is pinned, rather than guessing a segment", () => {
    const bot = createChatbot({ authTable: testUserTable });
    expect(() => bot.authenticated!.listConversations.getPath()).toThrow();
  });

  it("accepts a per-call canonical, so a browser needs no lock and no defs", () => {
    const bot = createChatbot({ authTable: testUserTable });
    expect(bot.authenticated!.listConversations.getPath({ canonical: "a1b2" })).toBe(
      "/api:a1b2/chat/conversations",
    );
  });
});
