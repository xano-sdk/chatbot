/**
 * The one AI-actions fixture every level uses: the golden bundle (`test/ai-bundle.test.ts`), the encode
 * tests, and `npm run test:live` (`test/live/index.ts`), which deploys it to a local Xano engine and runs
 * the module's generated tests plus the fixture's own below.
 *
 * Two record types so per-type dispatch is exercised: `note` (column context, applies write at once) and
 * `ticket` (function context, applies go through @xano-sdk/agents approvals). Its own auth table — this
 * package never imports @xano-sdk/auth.
 */
import { Xano, c, col, defineFunction, expr, f, fl, inp, input, ref, s, table, withFilters, workflowTest, type Value } from "@xano/sdk";
import { defineApprovals } from "@xano-sdk/agents";
import { defineAiActions } from "../src/index.js";

export const AI_FIXTURE_NAME = "xts-chatbot-ai";
export const AI_GOLDEN_URL = new URL("./fixtures/golden-ai-bundle.json", import.meta.url);

export function buildAiFixture() {
  const user = table({
    name: "person",
    auth: true,
    useXdo: false,
    schema: {
      name: f.text(),
      email: f.email({ required: true, methods: ["trim", "lower"] }),
      password: f.password(),
      role: f.enum(["admin", "editor", "viewer"], { required: true }),
    },
    index: [{ type: "unique", fields: [{ name: "email" }] }],
  });
  const note = table({
    name: "note",
    useXdo: false,
    schema: {
      owner_id: f.tableRef(user, { required: true }),
      title: f.text({ required: true }),
      body: f.text(),
      priority: f.int(),
      due_on: f.date({ nullable: true }),
      stage: f.enum(["idea", "writing", "review", "done"]),
      status: f.enum(["draft", "published"]),
    },
  });
  const ticket = table({
    name: "ticket",
    useXdo: false,
    schema: {
      requester_id: f.tableRef(user, { required: true }),
      subject: f.text({ required: true }),
      message: f.text(),
      reply: f.text(),
      urgency: f.enum(["low", "normal", "urgent"]),
    },
  });
  const ticketContext = defineFunction({
    name: "fixture/ticket_context",
    input: { record_id: input.int({ required: true }) },
    stack: [
      s.db.get({ table: ticket, fieldValue: inp("record_id"), as: "t" }),
      s.set_var("text", withFilters(c.text("Ticket context. Subject: "), fl.concat(ref("t.subject")), fl.concat(c.text(". Customer wrote: ")), fl.concat(ref("t.message")))),
    ],
    response: ref("text"),
  });

  const editorOrAdmin = (role: Value) => [expr(role, "!=", c.text("viewer"))];
  const ai = defineAiActions({
    user,
    stub: true,
    canonical: "ai",
    rateLimit: { max: 5, ttl: 3600 },
    approvals: { action: "apply_ai", label: "AI actions" },
    records: {
      note: {
        table: note,
        label: "note",
        titleField: "title",
        owner: "owner_id",
        context: ["title", "body", "priority", "due_on", "stage"],
        fields: {
          title: { type: "text", max: 80, required: true },
          body: { type: "text", max: 2000 },
          priority: { type: "int", min: 0, max: 5, hint: "0 is lowest, 5 is urgent" },
          due_on: { type: "date", label: "Due date" },
          stage: { type: "enum" },
        },
        draft: ["body"],
        extract: ["title", "priority", "due_on", "stage"],
        approval: false,
        can: { write: editorOrAdmin, others: (role) => expr(role, "=", c.text("admin")) },
        link: "/notes/{id}",
        test: { row: { title: "Launch checklist", body: "Steps for launch day.", priority: 2, stage: "writing", status: "draft" }, role: "editor" },
      },
      ticket: {
        table: ticket,
        label: "ticket",
        titleField: "subject",
        owner: "requester_id",
        context: ticketContext,
        fields: {
          subject: { type: "text", max: 120, required: true },
          reply: { type: "text", max: 4000 },
          urgency: { type: "enum", values: ["low", "normal", "urgent"] },
        },
        draft: ["reply"],
        extract: ["subject", "urgency"],
        can: { read: editorOrAdmin, write: editorOrAdmin, others: (role) => expr(role, "=", c.text("admin")) },
        link: "/tickets/{id}",
        test: { row: { subject: "Refund for order 1042", message: "I was charged twice.", urgency: "normal" }, role: "editor" },
      },
    },
  });
  const approvals = defineApprovals({
    user,
    actions: { apply_ai: { fn: ai.applyFn as never, label: "Apply AI changes", approvers: ["admin"] } },
  });

  // ── The fixture's own rules: role permissions and the approval gate ─────────────────────────────────
  const person = (as: string, role: string) => s.db.add({ table: user, as, row: { name: c.text(`Fixture ${as}`), email: c.text(`${as}@fixture.example`), password: c.text("Fixture-1234"), role: c.text(role) } });
  const find = (as: string) => s.db.get({ table: user, fieldName: "email", fieldValue: c.text(`${as}@fixture.example`), as });
  const newestNote = s.db.query({ table: note, sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as: "rows" });
  const newestTicket = s.db.query({ table: ticket, sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as: "rows" });
  const run = (as: string, actor: Value, type: string, id: Value, action: string, text = "") =>
    s.function.call({ fn: ai.runFn, as, input: { actor_id: actor, record_type: c.text(type), record_id: id, action: c.text(action), field: c.text(""), instruction: c.text(""), text: c.text(text) } });

  const fixtureTests = [
    workflowTest({
      name: "fixture: a viewer can run AI on their note but not apply",
      description: "can.write refuses a viewer's apply with a plain reason; the note is unchanged.",
      stack: [
        person("viewer", "viewer"),
        s.db.add({ table: note, as: "n", row: { owner_id: ref("viewer.id"), title: c.text("Reading list"), priority: c.int(1) } }),
        run("r", ref("viewer.id"), "note", ref("n.id"), "summarise"),
        s.expect.to_start_with({ expr: ref("r.text"), value: c.text("Test mode: ") }),
        s.expect.to_throw({ exception: c.text("You can't change this note"), body: [
          find("viewer"), newestNote,
          s.function.call({ fn: ai.applyFn, as: "x", input: { actor_id: ref("viewer.id"), record_type: c.text("note"), record_id: ref("rows.0.id"), values: c.obj({ title: "Changed" }) } }),
        ] }),
        s.db.get({ table: note, fieldValue: ref("n.id"), as: "after" }),
        s.expect.to_equal({ expr: ref("after.title"), value: c.text("Reading list") }),
      ],
    }),
    workflowTest({
      name: "fixture: a viewer can't use AI on tickets at all",
      description: "can.read refuses the run itself.",
      stack: [
        person("viewer", "viewer"),
        s.db.add({ table: ticket, as: "t", row: { requester_id: ref("viewer.id"), subject: c.text("Help"), urgency: c.text("low") } }),
        s.expect.to_throw({ exception: c.text("You can't use AI on tickets"), body: [find("viewer"), newestTicket, run("x", ref("viewer.id"), "ticket", ref("rows.0.id"), "summarise")] }),
      ],
    }),
    workflowTest({
      name: "fixture: an admin may act on someone else's note",
      description: "can.others lets an admin past the owner rule; the write is theirs.",
      stack: [
        person("editor", "editor"),
        person("admin", "admin"),
        s.db.add({ table: note, as: "n", row: { owner_id: ref("editor.id"), title: c.text("Q4 plan"), priority: c.int(1) } }),
        run("r", ref("admin.id"), "note", ref("n.id"), "summarise"),
        s.function.call({ fn: ai.applyFn, as: "applied", input: { actor_id: ref("admin.id"), record_type: c.text("note"), record_id: ref("n.id"), values: c.obj({ priority: 4 }) } }),
        s.db.get({ table: note, fieldValue: ref("n.id"), as: "after" }),
        s.expect.to_equal({ expr: ref("after.priority"), value: c.int(4) }),
        s.expect.to_equal({ expr: ref("after.owner_id"), value: ref("editor.id") }),
      ],
    }),
    workflowTest({
      name: "fixture: ticket context comes from the app's function",
      description: "A function context is what the model (here the stub) reads.",
      stack: [
        person("editor", "editor"),
        s.db.add({ table: ticket, as: "t", row: { requester_id: ref("editor.id"), subject: c.text("Charged twice"), message: c.text("Order 1042 shows two payments."), urgency: c.text("normal") } }),
        run("r", ref("editor.id"), "ticket", ref("t.id"), "summarise"),
        s.expect.to_contain({ expr: ref("r.text"), value: c.text("Order 1042 shows two payments") }),
      ],
    }),
    workflowTest({
      name: "fixture: a gated apply waits for approval, then writes as the approver",
      description: "Nothing is written until an admin approves; then only the validated values are written, as the admin.",
      stack: [
        person("editor", "editor"),
        person("admin", "admin"),
        s.db.add({ table: ticket, as: "t", row: { requester_id: ref("editor.id"), subject: c.text("Refund"), urgency: c.text("low") } }),
        s.function.call({ fn: ai.requestApplyFn, as: "asked", input: { actor_id: ref("editor.id"), record_type: c.text("ticket"), record_id: ref("t.id"), values: c.obj({ urgency: "urgent", reply: "We've refunded the second charge." }) } }),
        s.expect.to_equal({ expr: ref("asked.status"), value: c.text("pending") }),
        s.expect.to_be_defined({ expr: ref("asked.approval_id") }),
        s.db.get({ table: ticket, fieldValue: ref("t.id"), as: "before" }),
        s.expect.to_equal({ expr: ref("before.urgency"), value: c.text("low") }),
        s.db.get({ table: approvals.approval, fieldValue: ref("asked.approval_id"), as: "a" }),
        s.expect.to_equal({ expr: ref("a.action"), value: c.text("apply_ai") }),
        s.expect.to_equal({ expr: ref("a.link"), value: withFilters(c.text("/tickets/"), fl.concat(ref("t.id"))) }),
        s.expect.to_contain({ expr: ref("a.preview"), value: c.text("Urgency: urgent") }),
        s.function.call({ fn: approvals.decide, as: "done", input: { actor_id: ref("admin.id"), id: ref("asked.approval_id"), decision: c.text("approve"), edited: c.text("") } }),
        s.expect.to_equal({ expr: ref("done.status"), value: c.text("approved") }),
        s.db.get({ table: ticket, fieldValue: ref("t.id"), as: "after" }),
        s.expect.to_equal({ expr: ref("after.urgency"), value: c.text("urgent") }),
        s.expect.to_equal({ expr: ref("after.reply"), value: c.text("We've refunded the second charge.") }),
        s.db.query({ table: ai.usage, where: [expr(col("user_id"), "=", ref("admin.id")), expr(col("action"), "=", c.text("apply"))], returnType: "count", as: "applies" }),
        s.expect.to_equal({ expr: ref("applies"), value: c.int(1) }),
      ],
    }),
    workflowTest({
      name: "fixture: a gated apply with an invalid value is refused before anyone is asked",
      description: "Approvers only ever see changes that would pass validation.",
      stack: [
        person("editor", "editor"),
        s.db.add({ table: ticket, as: "t", row: { requester_id: ref("editor.id"), subject: c.text("Refund"), urgency: c.text("low") } }),
        s.expect.to_throw({ exception: c.text("Must be one of: low, normal, urgent"), body: [
          find("editor"), newestTicket,
          s.function.call({ fn: ai.requestApplyFn, as: "x", input: { actor_id: ref("editor.id"), record_type: c.text("ticket"), record_id: ref("rows.0.id"), values: c.obj({ urgency: "asap" }) } }),
        ] }),
        s.db.query({ table: approvals.approval, returnType: "count", as: "asked" }),
        s.expect.to_equal({ expr: ref("asked"), value: c.int(0) }),
      ],
    }),
  ];

  const xano = new Xano().registerWorkspace({ name: AI_FIXTURE_NAME }).registerTables([user, note, ticket]).registerFunctions([ticketContext]);
  ai.register(xano);
  approvals.register(xano);
  xano.registerWorkflowTests(fixtureTests);
  return { xano, ai, approvals, user, note, ticket };
}

export const buildAiGoldenBundle = () => buildAiFixture().xano.export();
export const serializeAiGolden = (bundle: unknown) => JSON.stringify(bundle, null, 2) + "\n";
