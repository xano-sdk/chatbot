# AI actions in a template (draft for templates-dex `CHATBOT.md` §6)

`@xano-sdk/chatbot` 1.2 adds **AI actions**: AI on one record, in the page where people work on it. A person
can summarise a ticket, draft its reply, or paste an email and get its fields filled. Nothing is written until
they apply, the server checks every value, and an apply can be undone or sent for approval.

## When the scope stage should pick it

Pick it when a card's main records carry **text people read or write** (tickets, leads, notes, job notes,
incident reports), or when data **arrives as text** to be typed in (emails, chat, meeting notes).
Typical wins:
- a support desk: summarise the thread, draft the reply, fill urgency and category from the customer's email;
- a CRM: fill a lead's company, size and stage from an email signature;
- a field-service app: summarise a job, and fill in the visit date and parts from the tech's message.

Skip it when records are mostly numbers or structured choices with nothing to read: AI would only add noise.

## Wiring (xano)

```ts
// xano/ai.ts
import { defineAiActions } from "@xano-sdk/chatbot";
import { user } from "./table/user.js";
import { note } from "./table/note.js";
import { rbac } from "./rbac.js";
import { changed } from "./base/functions.js";

export const ai = defineAiActions({
  user,
  canonical: "ai",
  stub: process.env.XANO_AI_STUB === "1",       // the local engine has no model: deterministic test answers
  approvals: { action: "apply_ai", label: "Lab AI" },
  records: {
    note: {
      table: note, label: "note", titleField: "title", owner: "owner_id", link: "/notes/{id}",
      context: ["title", "body", "priority", "stage", "due_on"],
      fields: {
        title: { type: "text", max: 120, required: true },
        body: { type: "text", max: 5000 },
        priority: { type: "int", min: 0, max: 5, hint: "0 is none, 5 is most urgent" },
        due_on: { type: "date", label: "Due date" },
      },
      draft: ["body"],
      extract: ["title", "priority", "due_on"],
      approval: false,                              // notes apply at once; set true to send applies to Approvals
      can: { write: (role) => rbac.has(role, "notes.write"), others: (role) => rbac.has(role, "notes.read_all") },
      test: { row: { title: "Launch checklist", body: "Steps.", status: "draft", priority: 2, stage: "idea" }, role: "editor" },
    },
  },
  onApply: ({ type, id, actor }) => [changed({ entity: type, id, actor, via: "AI" })],
});

// xano/approvals.ts: add the action (only needed if some type has approval: true)
//   apply_ai: { fn: ai.applyFn, label: "Apply AI changes" },
// xano/index.ts, after registerAgents(app, …):
//   ai.register(app);
```

- `fields` is the allowlist. List only what AI should ever change. Never include owner, status-like workflow
  columns, money, or anything a role guards on its own.
- `can` uses the template's rbac permissions. Never list roles.
- A keyed provider: `llm: { type: "openai", apiKey: "{{ $env.OPENAI_KEY }}", model: "gpt-4o-mini" }`, and declare
  `OPENAI_KEY` in the workspace env. Without it, the UI says "AI isn't connected".

## Wiring (frontend)

```tsx
import { createAiClient, AiActionMenu, AiSummary } from "@xano-sdk/chatbot/react";
export const ai = createAiClient({ apiBaseUrl: `${XANO_HOST}/api:ai`, getToken: () => token.get() });

// record header actions
<AiActionMenu client={ai} record={{ type: "note", id: note.id, title: note.title }} onApplied={() => refetch()} />
// the detail page's side panel
<AiSummary client={ai} record={{ type: "note", id: note.id }} />
```

Put the menu in the record's header actions and the summary at the top of the detail's side column. Don't
wrap them in another card. They use the kit's tokens and are complete on their own:
- every state: loading, empty with a first action, error with retry, not connected, rate limited, locked by role;
- 390 px and dark mode;
- keyboard, with focus returned after the dialogs.

## Seed data

Records the scope stage seeds should have **real text in the context columns** (a body with two or three
sentences). Otherwise a summary has nothing to say. For extract demos, give the guide a sample email:
"Title: Ship the beta / Priority: 4 / Due: 2026-11-03". `ai_usage` needs no seed.

## Verify

- `npm run test:live` in the package, or the template's `deploy --test`. The generated `ai:` workflow tests
  must pass: the allowlist, invalid values, someone else's record, actions never writing, extract validation,
  the usage log and the rate limit (the last four need `stub`).
- In the browser on the local engine (stub on), each must work:
  - summarise;
  - draft → edit → apply → undo;
  - extract → untick a field → apply.

  Any answer starting "Test mode:" is the stub.
- **Unverified locally:** real model answers. The local engine has no model, so check the prompts' output on a
  cloud ephemeral with a key, and say so in the build summary.
