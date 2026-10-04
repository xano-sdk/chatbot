/**
 * Agent encoding.
 *
 * The load-bearing assertion is `prompt_type: "messages"` with the template in
 * `prompt_messages` and `prompt` empty. That is not a style choice — it was
 * settled by probing a live instance, and it is the difference between the model
 * receiving structured turns and receiving a wall of JSON syntax. See the table in
 * `src/agent/chat-agent.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { tool, input, s, c, ref } from "@xano/sdk";
import { exportWith, section, guidFor, testUserTable, membersTable } from "./helpers.js";
import { MESSAGES_TEMPLATE, DEFAULT_SYSTEM_PROMPT, TOOLS_SYSTEM_PROMPT, createChatbot } from "../src/index.js";

const settings = (opts = {}) => section(exportWith(opts), "toolset")[0].agent_settings;

describe("prompt delivery", () => {
  it("uses prompt_type 'messages', so the engine decodes real LLM roles", () => {
    const s = settings();
    expect(s.prompt_type).toBe("messages");
    expect(s.prompt_messages).toBe(MESSAGES_TEMPLATE);
  });

  it("leaves `prompt` empty — the engine stores ONE prompt and messages is the live one", () => {
    // Authoring both used to compile with `messages` silently winning. Asserting
    // `prompt` is empty pins which side of that XOR this package is on.
    expect(settings().prompt).toBe("");
  });

  it("templates the transcript through $args, the only channel from a stack into an agent", () => {
    expect(settings().prompt_messages).toContain("$args.messages");
  });
});

describe("provider settings", () => {
  it("defaults to xano-free, which needs no API key", () => {
    // The turnkey promise: a fresh install answers a message with no credential
    // wiring at all.
    const s = settings();
    expect(s.type).toBe("xano-free");
    expect(s.configs["xano-free"]).toBeDefined();
  });

  it("carries the default system prompt", () => {
    expect(settings().system_prompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("carries a caller's system prompt — the one field most installs set", () => {
    const s = settings({ llm: { type: "xano-free", systemPrompt: "You are Acme support." } });
    expect(s.system_prompt).toBe("You are Acme support.");
  });

  it("supports a keyed provider and nests its config under configs.<provider>", () => {
    const s = settings({
      llm: { type: "anthropic", model: "claude-opus-5", apiKey: "{{ $env.ANTHROPIC_KEY }}" },
    });
    expect(s.type).toBe("anthropic");
    expect(s.configs.anthropic.model).toBe("claude-opus-5");
    // A credential belongs in an env var, not the bundle. Templating is how that
    // reaches the agent, so it must survive encoding verbatim.
    expect(s.configs.anthropic.apiKey).toBe("{{ $env.ANTHROPIC_KEY }}");
  });

  it("keeps the messages template when the provider changes", () => {
    // The transcript mechanism must not depend on which model is behind it.
    const s = settings({ llm: { type: "openai", model: "gpt-4o" } });
    expect(s.prompt_type).toBe("messages");
    expect(s.prompt_messages).toBe(MESSAGES_TEMPLATE);
  });
});

describe("shape", () => {
  it("declares no structured-output schema — a chat reply is free text", () => {
    // With one, `.result` would be an object where every caller expects a string.
    const s = settings();
    expect(s.structuredOutputs).toBe(false);
    expect(s.structuredOutputsSchema).toEqual([]);
  });

  it("ships no tools by default", () => {
    expect(section(exportWith(), "toolset")[0].tool).toEqual([]);
  });

  it("is stored as an agent, not an MCP server — they share the toolset section", () => {
    expect(section(exportWith(), "toolset")[0].type).toBe("agent");
  });

  it("has no public endpoint of its own", () => {
    // Agents are invoked in-stack via s.ai.agent.run; there is no route to guard.
    expect(section(exportWith(), "toolset")[0].canonical).toBe("");
  });
});

describe("tools", () => {
  const probe = tool({
    name: "lookup_order",
    description: "Look up an order by id.",
    input: { order_id: input.int({ required: true }) },
    stack: [s.set_var("result", c.text("shipped"))],
    response: ref("result"),
  });

  it("is tool-less by default — a plain assistant calls nothing", () => {
    const bot = createChatbot({ authTable: testUserTable });
    expect(bot.agent.tools).toEqual([]);
    expect(section(exportWith(), "toolset")[0].tool ?? []).toEqual([]);
  });

  it("carries a tool handle through to the agent def", () => {
    const bot = createChatbot({ authTable: testUserTable, tools: [probe] });
    expect(bot.agent.tools).toHaveLength(1);
  });

  it("resolves a handle to the tool's guid in the export", () => {
    // The reference must land on the SAME guid the tool itself emits, or the
    // agent points at nothing.
    const payload = exportWith({ tools: [probe] }, { extraTools: [probe] });
    const agentXdo = section(payload, "toolset")[0];
    // Encoded key is `tool` (singular); `id` carries the resolved guid.
    expect(agentXdo.tool[0].id).toBe(guidFor.tool("lookup_order"));
    // It must equal the guid the registered tool itself emits, or the agent
    // points at nothing.
    expect(agentXdo.tool[0].id).toBe(section(payload, "tool")[0].guid);
    // ...and never the `id: 0` null reference a bare handle used to produce.
    expect(agentXdo.tool[0].id).not.toBe(0);
  });

  it("accepts a bare tool NAME as well as a handle", () => {
    const payload = exportWith({ tools: ["lookup_order"] }, { extraTools: [probe] });
    expect(section(payload, "toolset")[0].tool[0].id).toBe(guidFor.tool("lookup_order"));
  });

  it("accepts the { tool, enabled, auth } wrapper", () => {
    const payload = exportWith({ tools: [{ tool: probe, enabled: false }] }, { extraTools: [probe] });
    const entry = section(payload, "toolset")[0].tool[0];
    expect(entry.enabled).toBe(false);
    expect(entry.id).toBe(guidFor.tool("lookup_order"));
  });

  it("REFERENCES tools without registering them — the authTable rule", () => {
    // The package must not register the consumer's tool: that is the consumer's
    // call (they may also expose it on an mcpServer), exactly as with authTable.
    // Proof: exporting WITHOUT registering it throws, naming the tool and the fix.
    expect(() => exportWith({ tools: [probe] })).toThrow(/references tool "lookup_order"/);
    // Registered by the consumer, the export succeeds and holds exactly one tool.
    expect(section(exportWith({ tools: [probe] }, { extraTools: [probe] }), "tool")).toHaveLength(1);
  });

  it("rejects a malformed entry at resolve time", () => {
    expect(() => createChatbot({ authTable: testUserTable, tools: [42 as never] })).toThrow(/tools\[0\]/);
    expect(() => createChatbot({ authTable: testUserTable, tools: ["" as never] })).toThrow(/tools\[0\]/);
    expect(() => createChatbot({ authTable: testUserTable, tools: "nope" as never })).toThrow(/tools/);
  });

  it("leaves maxSteps at the engine default unless asked, and passes it when asked", () => {
    // maxSteps only starts to matter once tools exist — it bounds tool/reasoning
    // steps, so a chain longer than the bound stops early.
    const bot = createChatbot({ authTable: testUserTable, tools: [probe], llm: { type: "xano-free", maxSteps: 9 } });
    expect((bot.agent.llm as any).maxSteps).toBe(9);
    const settings = section(exportWith({ tools: [probe], llm: { type: "xano-free", maxSteps: 9 } }, { extraTools: [probe] }), "toolset")[0]
      .agent_settings;
    expect(settings.max_steps).toBe(9);
  });
});

describe("tool execution must be permitted on the RUN, not just attached to the agent", () => {
  const probe = tool({
    name: "lookup_order",
    description: "Look up an order by id.",
    input: { order_id: input.int({ required: true }) },
    stack: [s.set_var("result", c.text("shipped"))],
    response: ref("result"),
  });

  /**
   * Regression guard, from a live failure.
   *
   * `tools` on the agent def makes the model AWARE of the tools; the engine only
   * lets it CALL one when the `ai.agent.run` statement carries
   * `allow_tool_execution`. Before this, a fully-wired tool produced
   * "I do not have access to real-time order data" — the feature failed silently
   * and looked like a model limitation rather than a missing flag.
   */
  const runOf = (payload: any) => {
    const fn = section(payload, "function")[0];
    return JSON.stringify(fn.run.find((st: any) => st.name?.includes("agent")));
  };

  it("permits execution when tools are configured", () => {
    expect(runOf(exportWith({ tools: [probe] }, { extraTools: [probe] }))).toContain("allow_tool_execution");
  });

  it("omits the flag entirely when there are no tools", () => {
    // Keeps a tool-less install's bundle unchanged — the flag would be noise.
    expect(runOf(exportWith())).not.toContain("allow_tool_execution");
  });
});

describe("the system prompt tells the model its tools exist", () => {
  const probe = tool({
    name: "lookup_order", description: "Look up an order.",
    input: { order_id: input.int({ required: true }) },
    stack: [s.set_var("result", c.text("shipped"))], response: ref("result"),
  });

  /**
   * From a live failure on a real workspace. With tools attached but nothing in
   * the prompt about them, the model answered "I do not know" and never called
   * the tool — the default prompt's "say so rather than guessing" actively steers
   * it away from trying. Asked explicitly it called the tool fine, so the wiring
   * was never the problem.
   */
  const promptOf = (payload: any) => section(payload, "toolset")[0].agent_settings.system_prompt;

  it("leaves the prompt alone when there are no tools", () => {
    expect(promptOf(exportWith())).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("appends the tool clause when tools are configured", () => {
    const p = promptOf(exportWith({ tools: [probe] }, { extraTools: [probe] }));
    expect(p).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(p).toContain(TOOLS_SYSTEM_PROMPT.trim());
  });

  it("appends it to a CALLER's prompt too — they may not know to say it", () => {
    const p = promptOf(
      exportWith({ tools: [probe], llm: { type: "xano-free", systemPrompt: "You are Acme support." } },
        { extraTools: [probe] }),
    );
    expect(p).toContain("You are Acme support.");
    expect(p).toContain(TOOLS_SYSTEM_PROMPT.trim());
  });

  it("does not append it to a caller's prompt when there are no tools", () => {
    const p = promptOf(exportWith({ llm: { type: "xano-free", systemPrompt: "You are Acme support." } }));
    expect(p).toBe("You are Acme support.");
  });
});

describe("per-tool auth — the silent-failure fix", () => {
  /**
   * The most expensive defect this package has shipped, from a live build log
   * (dev-log 2026-08-31): eight tools, all correctly resolved, `enabled: true`,
   * deployed clean — and every one of them threw `ERROR_CODE_ACCESS_DENIED` on
   * its first statement, because a bare handle encodes `auth: false` and
   * `auth("id")` in a PUBLIC stack raises rather than resolving to null. The
   * agent swallowed the throw and the model answered "I saved that note".
   *
   * Nothing about it was visible: no 500, no error in the reply, no export
   * warning. So the default moved instead.
   */
  const probe = tool({
    name: "save_note",
    description: "Save a note for the current user.",
    input: { body: input.text({ required: true }) },
    stack: [s.set_var("result", c.text("ok"))],
    response: ref("result"),
  });

  const entryOf = (opts: any) =>
    section(exportWith(opts, { extraTools: [probe] }), "toolset")[0].tool[0];

  it("scopes a BARE handle to the auth table — the spelling every example used", () => {
    expect(entryOf({ tools: [probe] }).auth).toBe(guidFor.table("test_user"));
  });

  it("scopes a bare tool NAME the same way", () => {
    expect(entryOf({ tools: ["save_note"] }).auth).toBe(guidFor.table("test_user"));
  });

  it("scopes a wrapper that names no auth, and keeps its other fields", () => {
    const entry = entryOf({ tools: [{ tool: probe, enabled: false }] });
    expect(entry.auth).toBe(guidFor.table("test_user"));
    expect(entry.enabled).toBe(false);
  });

  it("leaves an explicit `auth: false` public — the documented opt-out", () => {
    // A tool that genuinely serves anonymous callers has to stay public, so the
    // opt-out must survive the default. It is also the ONLY spelling that now
    // produces a public tool, which is what makes it readable as intent.
    expect(entryOf({ tools: [{ tool: probe, auth: false }] }).auth).toBe(false);
  });

  it("leaves an auth table the caller named alone", () => {
    const payload = exportWith(
      { tools: [{ tool: probe, auth: membersTable }] },
      { extraTools: [probe], extraTables: [membersTable] },
    );
    expect(section(payload, "toolset")[0].tool[0].auth).toBe(guidFor.table("members"));
  });

  it("resolves to the SAME guid the auth table itself emits", () => {
    // A guid that merely looks right is the failure this rules out: the tool's
    // `auth` must land on the table the endpoints authenticate against, or
    // `auth("id")` binds nothing at runtime.
    const payload = exportWith({ tools: [probe] }, { extraTools: [probe] });
    const authTableGuid = section(payload, "dbo").find((t: any) => t.name === "test_user").guid;
    expect(section(payload, "toolset")[0].tool[0].auth).toBe(authTableGuid);
  });

  it("does not scope a guest-only install — it has no auth table to scope to", () => {
    // `auth()` cannot work on a public endpoint either way. Defaulting here
    // would break the tool instead of fixing it.
    const payload = exportWith(
      { authenticated: false, guest: true, authTable: undefined, tools: [probe] } as any,
      { extraTools: [probe] },
    );
    expect(section(payload, "toolset")[0].tool[0].auth).toBe(false);
  });

  it("resolves options rather than mutating the caller's array", () => {
    // The caller's `tools` is theirs — they may pass the same array to an
    // mcpServer, where a chatbot's auth table has no business appearing.
    const authored: any[] = [probe];
    createChatbot({ authTable: testUserTable, tools: authored });
    expect(authored[0]).toBe(probe);
  });

  it("warns when a scoped tool is also reachable from the PUBLIC guest family", () => {
    // The same failure inverted: one agent serves both families and an entry
    // carries one `auth`, so a tool bound to the auth table has no caller to
    // bind to on a guest send. It cannot be fixed for the author — but it must
    // not ship in silence, which is the whole lesson of this defect.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createChatbot({ authTable: testUserTable, guest: true, tools: [probe] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/guest/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when every tool given to a guest-enabled bot is explicitly public", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createChatbot({ authTable: testUserTable, guest: true, tools: [{ tool: probe, auth: false }] });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tool_calls — what a client can observe", () => {
  /**
   * From the same live build log. `ChatReply.tool_calls` came back `null` on
   * every send, and `llms.txt` read as a promise that a client could see tool
   * activity — so a null field looked like proof that no tool had run, when in
   * fact every tool had run and thrown.
   *
   * The cause was a name: this package read `run.tool_calls`, and the engine's
   * agent-run envelope carries `toolCalls` (core types it as `AgentRunResult`).
   * The field could never have been populated by any configuration.
   */
  const probe = tool({
    name: "save_note",
    description: "Save a note.",
    input: { body: input.text({ required: true }) },
    stack: [s.set_var("result", c.text("ok"))],
    response: ref("result"),
  });

  const fnOf = (opts: any = {}, extra: any = {}) =>
    section(exportWith(opts, extra), "function")[0];
  const resultField = (fn: any, name: string) =>
    fn.result.find((r: any) => r.name === name);

  it("reads the calls out of `steps`, not the key that does not exist", () => {
    // Two wrong answers, both settled live. `run.tool_calls` is a key the
    // envelope never carries, and the top-level `toolCalls` it DOES carry is
    // always `[]` even when a tool wrote a row. The calls are in
    // `steps[].content[]`.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const text = JSON.stringify(fn.run);
    expect(text).toContain('"steps"');
    expect(text).not.toContain("tool_calls");
    expect(text).not.toContain('"toolCalls"');
  });

  it("defaults a missing `steps` to [] rather than null", () => {
    // The model answers most turns without calling anything, and looping over a
    // null collection is not a shape worth depending on.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const steps = fn.run.find((st: any) => st.as === "run_steps");
    const get = steps.context.filters.find((f: any) => f.name === "get");
    expect(get.arg[0].value).toBe("steps");
    expect(get.arg[1]).toEqual({ value: "[]", tag: "const:array", filters: [] });
  });

  it("separates tool CALLS from tool RESULTS, and projects names", () => {
    // Both entry types carry `toolName`, so without the `type` split every call
    // would be reported twice. And a tool-result carries the tool's whole return
    // value, which is data no client asked for.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const loop = fn.run.find((st: any) => st.name === "mvp:foreach");
    const body = JSON.stringify(loop.context.run);
    expect(body).toContain("index_by");
    expect(body).toContain("tool-call");
    expect(body).not.toContain("tool-result");
    expect(body).toContain("toolName");
  });

  it("appends per step, so a tool called twice is reported twice", () => {
    // Verified live: two save_note calls and one list_notes came back as
    // ["save_note", "save_note", "list_notes"], in call order.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const loop = fn.run.find((st: any) => st.name === "mvp:foreach");
    expect(JSON.stringify(loop.context.run)).toContain("array_merge");
  });

  it("uses no lambda — a bounded workspace-wide resource, on every send", () => {
    // `fl.map` with a JS body does the same job in one filter and was verified
    // live. Core is explicit that a lambda is an escape hatch drawing on a
    // shared worker pool; four statements express this without one.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    expect(JSON.stringify(fn.run)).not.toContain("lambda");
  });

  it("hands the client an array on the response, filtered of unnamed calls", () => {
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const field = resultField(fn, "tool_calls");
    expect(field.value).toBe("tool_call_names");
    expect(field.filters.map((f: any) => f.name)).toEqual(["filter_null"]);
  });

  it("returns a constant [] on a tool-less install, and adds no statements", () => {
    // A client's `tool_calls.length` must not depend on how the bot was
    // configured — and a bot with no tools pays nothing for the field.
    const fn = fnOf();
    expect(resultField(fn, "tool_calls")).toMatchObject({ value: "[]", tag: "const:array" });
    expect(fn.run.some((st: any) => st.as === "run_steps")).toBe(false);
    expect(fn.run.some((st: any) => st.name === "mvp:foreach")).toBe(false);
  });

  it("keeps the field out of the stored transcript", () => {
    // Tool activity is a property of one RUN, not a message. Writing it into
    // `conversation_message` would replay it into the model's context forever.
    const fn = fnOf({ tools: [probe] }, { extraTools: [probe] });
    const adds = fn.run.filter((st: any) => st.name === "mvp:db_add");
    expect(JSON.stringify(adds)).not.toContain("tool_call");
  });
});
