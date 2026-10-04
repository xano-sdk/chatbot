/**
 * Endpoint encoding — routes, auth binding, and the authorization guards.
 *
 * Several assertions here pin a *security* property rather than a shape, and each
 * says which live failure it prevents. Those are the ones not to "simplify".
 */
import { describe, it, expect } from "vitest";
import { exportWith, queriesByName, section, guidFor, testUserTable } from "./helpers.js";

const AUTHED = [
  "chat/conversations/create",
  "chat/conversations",
  "chat/conversations/{conversation_id}/messages",
  "chat/conversations/{conversation_id}/send",
  "chat/conversations/{conversation_id}",
];
const GUEST = [
  "chat/guest/conversations/create",
  "chat/guest/conversations/{conversation_id}/messages",
  "chat/guest/conversations/{conversation_id}/send",
  "chat/guest/conversations/{conversation_id}/delete",
];

/**
 * A query's stack lives in `run[]` and its response in `result` — the engine's
 * payload spelling, not the authoring spelling (`stack` / `response`).
 * Statement names are the engine's `mvp:*` ids.
 */
const stackNames = (q: any): string[] =>
  (q?.run ?? []).map((st: any) => st?.name).filter(Boolean);

/** The whole stack as text, for "does this guard exist at all" assertions. */
const stackText = (q: any) => JSON.stringify(q?.run ?? []);

describe("route names", () => {
  it("registers exactly the authenticated family by default", () => {
    expect(Object.keys(queriesByName(exportWith())).sort()).toEqual([...AUTHED].sort());
  });

  it("adds the guest family and the claim bridge when guests are on", () => {
    const names = Object.keys(queriesByName(exportWith({ guest: true })));
    expect(names.sort()).toEqual(
      [...AUTHED, "chat/conversations/{conversation_id}/claim", ...GUEST].sort(),
    );
  });

  it("registers only the guest family for an anonymous-only install", () => {
    const names = Object.keys(queriesByName(exportWith({ authenticated: false, guest: true })));
    expect(names.sort()).toEqual([...GUEST].sort());
  });

  it("gives every endpoint a UNIQUE name, because a query's guid derives from name alone", () => {
    // Verified: deriveGuid("query", name) ignores the verb, so a RESTful
    // GET/POST pair on one path would be two defs claiming one identity. Pinning
    // guids would fix it and is exactly what this package must not do.
    const payload = exportWith({ guest: true });
    const names = section(payload, "query").map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every endpoint a UNIQUE guid", () => {
    const guids = section(exportWith({ guest: true }), "query").map((q) => q.guid);
    expect(new Set(guids).size).toBe(guids.length);
  });

  it("keeps verbs semantically honest despite the distinct names", () => {
    const q = queriesByName(exportWith({ guest: true }));
    expect(q["chat/conversations"].verb).toBe("GET");
    expect(q["chat/conversations/create"].verb).toBe("POST");
    expect(q["chat/conversations/{conversation_id}"].verb).toBe("DELETE");
    expect(q["chat/conversations/{conversation_id}/messages"].verb).toBe("GET");
  });

  it("uses POST for the guest delete, keeping the capability out of the URL", () => {
    // A DELETE would have to carry `session_token` as a query string — into access
    // logs, proxies and Referer headers. A body keeps it out.
    expect(queriesByName(exportWith({ guest: true }))["chat/guest/conversations/{conversation_id}/delete"].verb).toBe(
      "POST",
    );
  });
});

describe("auth binding", () => {
  it("binds every authenticated endpoint to the caller's table, by guid", () => {
    const q = queriesByName(exportWith({ guest: true }));
    for (const name of [...AUTHED, "chat/conversations/{conversation_id}/claim"]) {
      expect(q[name].auth, name).toBe(guidFor.table(testUserTable.name));
    }
  });

  it("leaves every guest endpoint public", () => {
    const q = queriesByName(exportWith({ guest: true }));
    for (const name of GUEST) expect(q[name].auth, name).toBe(false);
  });

  it("no guest endpoint references auth(), which would raise ACCESS_DENIED at runtime", () => {
    // Verified live: touching auth() in a public stack raises rather than
    // resolving to null — even when the caller supplies a valid token. This is the
    // assertion that keeps the two families from being merged by mistake.
    const payload = exportWith({ guest: true });
    const q = queriesByName(payload);
    for (const name of GUEST) {
      // The auth tag is how `auth()` encodes: {"operand":"id","tag":"auth"}.
      expect(stackText(q[name]), name).not.toContain('"tag": "auth"');
      expect(stackText(q[name]), name).not.toContain('"tag":"auth"');
    }
  });

  it("follows a different auth table", () => {
    const q = queriesByName(exportWith({ authTable: testUserTable }));
    expect(q["chat/conversations"].auth).toBe(guidFor.table("test_user"));
  });
});

describe("authorization guards", () => {
  const q = () => queriesByName(exportWith({ guest: true }));

  for (const name of [
    "chat/conversations/{conversation_id}/messages",
    "chat/conversations/{conversation_id}/send",
    "chat/conversations/{conversation_id}",
  ]) {
    it(`${name} checks ownership before touching anything else`, () => {
      // Index-independent on purpose: a rate limiter may legitimately precede
      // the guard (cheapest rejection first). What must NOT change is that the
      // guard is the first thing to read data, and that its precondition
      // immediately follows its read.
      const names = stackNames(q()[name]);
      const get = names.indexOf("mvp:dbo_getby");
      expect(get, "the guard's read must be present").toBeGreaterThanOrEqual(0);
      expect(names[get + 1], "the precondition must immediately follow the read").toBe("mvp:precondition");
      // Only a rate limiter may run before the guard — nothing else.
      expect(names.slice(0, get).every((n) => n === "mvp:redis_ratelimit")).toBe(true);
    });
  }

  it("guards read the conversation with an explicit output list, not the whole row", () => {
    const run = q()["chat/conversations/{conversation_id}/send"].run;
    const get = run.find((st: any) => st.name === "mvp:dbo_getby");
    expect(JSON.stringify(get)).toContain("user_id");
  });

  it("reports a missing thread and someone else's thread identically", () => {
    // An accessdenied on a thread that exists but isn't yours confirms its
    // existence to anyone enumerating ids.
    const pre = JSON.stringify(q()["chat/conversations/{conversation_id}/messages"].run[1]);
    expect(pre).toContain("notfound");
    expect(pre).toContain("Conversation not found.");
  });

  it("uses a SAFE ref in the ownership comparison", () => {
    // db.get binds null on a miss; an unguarded dotted ref through null is a
    // runtime "Unable to locate var" — a 500 on the ordinary wrong-id path.
    // A safe ref encodes as a `get` filter carrying a null default, so a miss
    // drills to null instead of raising.
    const pre = JSON.stringify(q()["chat/conversations/{conversation_id}/messages"].run[1]);
    expect(pre).toContain('"name":"get"');
    expect(pre).toContain("const:null");
  });

  it("rejects a blank guest token before comparing it", () => {
    // Historically `required: true` accepted "" — see the note in
    // `src/api/guest.ts`; the engine now refuses it up front, but the guard
    // stays. It must still be the first thing the GUARD does, i.e. before the
    // row is read. A rate limiter ahead of it is allowed.
    const send = q()["chat/guest/conversations/{conversation_id}/send"];
    const names = stackNames(send);
    const firstGuard = names.findIndex((n: string) => n !== "mvp:redis_ratelimit");
    expect(names[firstGuard]).toBe("mvp:precondition");
    expect(firstGuard).toBeLessThan(names.indexOf("mvp:dbo_getby"));
    expect(JSON.stringify(send.run[firstGuard])).toContain("session_token");
  });

  it("refuses a guest token once the thread has an owner", () => {
    // Claiming must END the token's authority, or logging in would leave a second,
    // weaker credential permanently valid.
    expect(stackText(q()["chat/guest/conversations/{conversation_id}/send"])).toContain(
      "now belongs to an account",
    );
  });

  it("omits that check when there is no authenticated family to claim things", () => {
    const payload = exportWith({ authenticated: false, guest: true });
    expect(stackText(queriesByName(payload)[GUEST[1]!])).not.toContain("now belongs to an account");
  });
});

describe("the claim bridge", () => {
  it("only exists when both families do", () => {
    expect(queriesByName(exportWith())["chat/conversations/{conversation_id}/claim"]).toBeUndefined();
    expect(
      queriesByName(exportWith({ guest: true }))["chat/conversations/{conversation_id}/claim"],
    ).toBeDefined();
  });

  it("requires the token AND that the thread be unclaimed", () => {
    // Without the unclaimed check, anyone who ever held the token could re-claim
    // the thread away from its current owner.
    const text = stackText(
      queriesByName(exportWith({ guest: true }))["chat/conversations/{conversation_id}/claim"],
    );
    expect(text).toContain("Conversation not found.");
    expect(text).toContain("already been claimed");
  });

  it("never returns the session_token it was given", () => {
    const claim = queriesByName(exportWith({ guest: true }))["chat/conversations/{conversation_id}/claim"];
    expect(JSON.stringify(claim.result)).not.toContain("session_token");
  });
});

describe("the session_token is emitted exactly once", () => {
  it("only guest create returns it", () => {
    // It is a bearer capability. Every other endpoint reads it inside the stack
    // (an `internal` column needs an explicit output list) and never serves it.
    const payload = exportWith({ guest: true });
    const emitting = section(payload, "query").filter((q) =>
      JSON.stringify(q.result ?? {}).includes("session_token"),
    );
    expect(emitting.map((q) => q.name)).toEqual(["chat/guest/conversations/create"]);
  });

  it("serves it from the minted value, not by re-reading the stored row", () => {
    const create = queriesByName(exportWith({ guest: true }))["chat/guest/conversations/create"];
    const names = stackNames(create);
    // The token must be minted before the row is written, and nothing but a rate
    // limiter may precede it.
    const mint = names.indexOf("mvp:uuid4");
    expect(mint).toBeGreaterThanOrEqual(0);
    expect(names.slice(0, mint).every((n: string) => n === "mvp:redis_ratelimit")).toBe(true);
    expect(mint).toBeLessThan(names.indexOf("mvp:dbo_add"));
  });
});

describe("the authenticated create fills session_token when guests exist", () => {
  it("mints one, so repeated creates cannot collide on the unique index", () => {
    // Caught live: an omitted column takes its type default ("") on db.add, so the
    // FIRST authenticated create succeeded and the SECOND died on
    // `duplicate key value violates unique constraint`.
    const create = queriesByName(exportWith({ guest: true }))["chat/conversations/create"];
    expect(stackNames(create)).toEqual(["mvp:uuid4", "mvp:dbo_add"]);
    expect(stackText(create)).toContain("session_token");
  });

  it("mints nothing when there is no such column", () => {
    const create = queriesByName(exportWith())["chat/conversations/create"];
    expect(stackNames(create)).toEqual(["mvp:dbo_add"]);
    expect(stackText(create)).not.toContain("session_token");
  });

  it("still never returns it", () => {
    const create = queriesByName(exportWith({ guest: true }))["chat/conversations/create"];
    expect(JSON.stringify(create.result ?? {})).not.toContain("session_token");
  });
});

describe("both send endpoints delegate to the one reply function", () => {
  it("so the agent logic has exactly one copy", () => {
    const payload = exportWith({ guest: true });
    const q = queriesByName(payload);
    for (const name of [
      "chat/conversations/{conversation_id}/send",
      "chat/guest/conversations/{conversation_id}/send",
    ]) {
      const names = stackNames(q[name]);
      expect(names, name).toContain("mvp:function");
      // Neither send endpoint runs the agent itself.
      expect(names, name).not.toContain("mvp:call_agent");
    }
  });

  it("references the reply function by guid", () => {
    const send = queriesByName(exportWith())["chat/conversations/{conversation_id}/send"];
    expect(stackText(send)).toContain(guidFor.fn("chatbot/generate_reply"));
  });
});

describe("deletion", () => {
  it("removes messages before the conversation", () => {
    // The other order orphans message rows if the second delete fails, and the FK
    // is a reference, not a cascade — nothing would ever collect them.
    const names = stackNames(queriesByName(exportWith())["chat/conversations/{conversation_id}"]);
    expect(names).toEqual([
      "mvp:dbo_getby",
      "mvp:precondition",
      "mvp:dbo_bulkdelete",
      "mvp:dbo_delby",
    ]);
  });

  it("scopes the bulk delete — an unfiltered one would wipe every message in the workspace", () => {
    const q = queriesByName(exportWith())["chat/conversations/{conversation_id}"];
    const bulk = q.run.find((st: any) => st.name === "mvp:dbo_bulkdelete");
    expect(JSON.stringify(bulk)).toContain("conversation_id");
  });
});

describe("path params", () => {
  it("every {param} has a matching scalar input", () => {
    // A marker with no input deploys as a permanently-broken route.
    for (const q of section(exportWith({ guest: true }), "query")) {
      for (const param of [...String(q.name).matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
        expect(q.input.map((i: any) => i.name), q.name).toContain(param);
      }
    }
  });
});

describe("request history", () => {
  it("is off on the group, so message text and guest tokens are not persisted", () => {
    const group = section(exportWith({ guest: true }), "app")[0];
    expect(group.history.inherit).toBe(false);
    expect(group.history.query_enabled).toBe(false);
  });

  it("can be opted back in for debugging", () => {
    const group = section(exportWith({ history: true }), "app")[0];
    expect(group.history.query_enabled).toBe(true);
  });
});

describe("whitespace-only content cannot reach the model", () => {
  /**
   * Regression guard, from a live failure.
   *
   * `content` was `required: true` with no `trim`, and the reply function
   * compared it against `""`. A whitespace-only message ("   ") therefore passed
   * BOTH checks: length 3 satisfies `required`, and `"   " !== ""`. Verified on a
   * live ephemeral — it returned 200, the blank turn was stored, the model
   * confabulated ("I can't respond to an empty message"), and that reply was
   * stored too, poisoning every later turn's context.
   *
   * Two independent fixes, because there are two entry points:
   *  - the send endpoints trim at the input, so "   " arrives as "" and the
   *    engine refuses it as a missing param before the stack runs;
   *  - the shared reply function compares the TRIMMED value, because a direct
   *    `s.function.run` caller never runs an endpoint's input methods.
   */
  const sendPaths = [
    "chat/conversations/{conversation_id}/send",
    "chat/guest/conversations/{conversation_id}/send",
  ];

  for (const path of sendPaths) {
    it(`trims content on ${path}`, () => {
      const q = queriesByName(exportWith({ guest: true }))[path];
      const content = q.input.find((i: any) => i.name === "content");
      expect(content).toBeDefined();
      expect(content.methods.map((m: any) => m.name)).toContain("trim");
      // Still required — trimming must not soften the requirement.
      expect(JSON.stringify(content)).toContain("required");
    });
  }

  it("compares the trimmed value in the shared reply function", () => {
    // Take the one function the package registers rather than hardcoding its
    // name — the name is configurable via `names.replyFn`.
    const fns = section(exportWith({ guest: true }), "function");
    expect(fns).toHaveLength(1);
    const fn = fns[0];
    const guard = JSON.stringify(fn.run).match(/\{[^{}]*"trim"[^{}]*\}/);
    expect(guard, "the empty-content precondition must pipe content through trim").not.toBeNull();
    expect(JSON.stringify(fn.run)).toContain("Message content cannot be empty.");
  });
});

describe("rate limiting on the metered endpoints", () => {
  const limited = (payload: any, path: string) =>
    JSON.stringify(queriesByName(payload)[path].run[0]);

  it("is ON by default and guards the model-invoking endpoints", () => {
    const p = exportWith({ guest: true });
    expect(limited(p, "chat/conversations/{conversation_id}/send")).toContain("ratelimit");
    expect(limited(p, "chat/guest/conversations/{conversation_id}/send")).toContain("ratelimit");
    // The only unauthenticated write.
    expect(limited(p, "chat/guest/conversations/create")).toContain("ratelimit");
  });

  it("does NOT limit reads", () => {
    const p = exportWith({ guest: true });
    for (const path of [
      "chat/conversations",
      "chat/conversations/{conversation_id}/messages",
      "chat/guest/conversations/{conversation_id}/messages",
    ]) {
      expect(JSON.stringify(queriesByName(p)[path].run), path).not.toContain("ratelimit");
    }
  });

  it("runs FIRST, before the ownership guard", () => {
    // So a caller probing conversation ids burns their own budget, and the
    // cheapest possible rejection happens before any DB read.
    const run = queriesByName(exportWith({ guest: true }))["chat/conversations/{conversation_id}/send"].run;
    expect(run[0].name).toBe("mvp:redis_ratelimit");
    expect(run[1].name).toBe("mvp:dbo_getby");
  });

  it("keys the authenticated limiter on the caller, not a shared bucket", () => {
    const q = limited(exportWith(), "chat/conversations/{conversation_id}/send");
    expect(q).toContain("auth");
    expect(q).not.toContain("remote_ip");
  });

  it("keys the GUEST limiter on remote_ip, because auth() is null there", () => {
    // The collapse core warns about: an auth-keyed limiter on a public endpoint
    // puts every caller in the world in one bucket.
    const q = limited(exportWith({ guest: true }), "chat/guest/conversations/{conversation_id}/send");
    expect(q).toContain("$remote_ip");
  });

  it("gives the two families separate buckets", () => {
    const p = exportWith({ guest: true });
    const a = limited(p, "chat/conversations/{conversation_id}/send");
    const g = limited(p, "chat/guest/conversations/{conversation_id}/send");
    expect(a).toContain("chat:send:");
    expect(g).toContain("chat:guest:send:");
  });

  it("namespaces the bucket by routePrefix so two chatbots do not share one", () => {
    const p = exportWith({ guest: true, routePrefix: "support", names: {
      conversation: "s_conversation", message: "s_message", agent: "s_agent",
      apiGroup: "S", replyFn: "s/reply",
    } });
    expect(limited(p, "support/conversations/{conversation_id}/send")).toContain("support:send:");
  });

  it("can be turned off entirely", () => {
    const p = exportWith({ guest: true, rateLimit: false });
    for (const path of [
      "chat/conversations/{conversation_id}/send",
      "chat/guest/conversations/{conversation_id}/send",
      "chat/guest/conversations/create",
    ]) {
      expect(JSON.stringify(queriesByName(p)[path].run), path).not.toContain("ratelimit");
    }
  });

  it("honours max and ttl", () => {
    const q = limited(exportWith({ rateLimit: { max: 3, ttl: 90 } }), "chat/conversations/{conversation_id}/send");
    expect(q).toContain('"max"');
    expect(q).toContain("90");
  });
});

describe("the history window", () => {
  /**
   * Pins the two facts that make `historyLimit` mean what the docs say.
   *
   * Verified live at `historyLimit: 2`: the model received `[previous assistant
   * reply, current user message]` and could NOT answer a question about the
   * user's own previous statement — because the current turn is written before
   * the history is read, so it consumes one slot.
   */
  it("caps the history read at exactly historyLimit", () => {
    const fn = section(exportWith({ historyLimit: 7 }), "function")[0];
    // `db.query` encodes as `mvp:dbo_view`.
    const read = fn.run.find(
      (st: any) => st.name === "mvp:dbo_view" && JSON.stringify(st).includes("per_page"),
    );
    expect(read, "the capped history read must exist").toBeDefined();
    expect(JSON.stringify(read)).toContain("7");
  });

  it("writes the user's turn BEFORE reading the history, so the turn counts", () => {
    // Reverse these and `historyLimit` would silently mean one more message than
    // it does, and the model would never see the message it is answering.
    const names = section(exportWith(), "function")[0].run.map((st: any) => st.name);
    const write = names.indexOf("mvp:dbo_add");
    const read = names.indexOf("mvp:dbo_view");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(write);
  });
});
