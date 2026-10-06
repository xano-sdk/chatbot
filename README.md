# @xano-sdk/chatbot

A [Xano SDK](https://www.npmjs.com/package/@xano/sdk) package that ships a
working conversational AI assistant — the `conversation` and
`conversation_message` tables, a Xano AI **agent**, and the chat endpoints that
drive them — as typed defs you can register into any workspace and version behind
npm.

Install it, point it at the table your users live in, write a system prompt. That
is the whole setup: the thread, its history, and the model call are already wired.

```bash
npm install @xano-sdk/chatbot @xano/sdk
# or scaffold a project with it already registered (auth is wired first):
xanosdk init my-app --marketplace @xano-sdk/auth,@xano-sdk/chatbot
# or, inside an existing project: install it and print the registration to paste
xanosdk marketplace install @xano-sdk/chatbot
```

```ts
// xano/index.ts
import { workspace } from "@xano/sdk";
import { registerAuth, userTable } from "@xano-sdk/auth";
import { registerChatbot } from "@xano-sdk/chatbot";

const xano = registerAuth(workspace("my-app"), { canonical: "authn" });

export const bot = registerChatbot(xano, {
  authTable: userTable,
  llm: { type: "xano-free", systemPrompt: "You are a support agent for Acme." },
});

export default bot.xano;   // the default export must be the Xano registry
```

```bash
npx xanosdk deploy ./xano/index.ts
```

```bash
curl -X POST "$BASE/api:$CANONICAL/chat/conversations/create" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
# → { "id": 1, "created_at": …, "title": "", "last_message_at": null }

curl -X POST "$BASE/api:$CANONICAL/chat/conversations/1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"My favourite colour is chartreuse. Just acknowledge."}'
# → { "conversation_id": 1, "reply": "Acknowledged.", "message_id": 2 }

curl -X POST "$BASE/api:$CANONICAL/chat/conversations/1/send" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"What is my favourite colour?"}'
# → { "reply": "Your favourite colour is chartreuse.", … }
```

That second reply is the point of the package. Nothing in your stack had to
assemble a transcript, and nothing in the client had to resend one.

## It does not depend on `@xano-sdk/auth`

Nothing here imports it. `authTable` takes any `table()` handle or table name, so
the `@xano-sdk/auth` example above is a convention, not a coupling — your own auth
table works identically:

```ts
const members = table({ name: "members", auth: true, schema: { /* … */ } });
registerChatbot(xano, { authTable: members });
```

`table({ auth: true })` is the **convention**, not the mechanism. Xano gates a
request by comparing the token's table against the endpoint's configured table
*by name*, and mints a token for any table by name — neither side reads the flag,
which only decides what the editor's auth picker offers. So an unflagged table
authenticates fine; the SDK just warns at export.

Two things to know when passing a **bare name**:

- The table must still be registered on the workspace. The SDK resolves the
  reference to a name-derived guid with no registry lookup, then errors at export
  if nothing matches — deliberately, since a mistyped name would otherwise
  produce a valid-looking guid that only fails at deploy.
- The SDK cannot read a primary-key type off a name, so pass
  `{ userIdType: "uuid" }` for a uuid-keyed table. With a **handle** the SDK reads
  `idType` itself and throws on a mismatch, which is why the handle is preferred.

A raw numeric `dbo.id` is **not** accepted, unlike the SDK's `auth` option. The same
table is also the target of `conversation.user_id`, and `f.tableRef` resolves
through `ObjectRef` (`string | { name, guid? }`), which has no numeric form.

## Building a frontend

The short version, in order: generate `xano/routes.gen.ts` with
`npx xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts`, `import type`
the request/response types from this package, and wire four calls — list,
create, transcript, send. Render assistant turns as Markdown with raw HTML disabled and user turns as plain
text, serialize sends per thread, and handle `401`/`404`/`429`.

`llms.txt` carries the same path as a single checklist, and each item has a
section of its own below.

### Or start from the included frontend (optional)

`@xano-sdk/chatbot/react` is a complete, ready-to-use assistant UI built on exactly that checklist. Use it
as is, or read it as the reference for your own. The backend never depends on it, and React is an
*optional* peer.

```bash
npm install react react-dom   # only needed for this entry
```

```tsx
import { createChatClient, Chat, ChatWidget } from "@xano-sdk/chatbot/react";

const chatClient = createChatClient({
  apiBaseUrl: `${XANO_HOST}/api:chat`,   // your backend + /api:<canonical> (routes.gen.ts has it)
  getToken: () => session.token,            // the signed-in person's token
});

// a full page: chats down the side (a drawer on a phone), the conversation, the composer
<Chat client={chatClient} assistantName="Desk assistant"
  welcome="Ask about your queue, or find a ticket."
  suggestions={["Summarise my queue", "What's urgent?"]}
  onUnauthorized={signOut} />

// or a launcher in the corner of any page, opening the person's latest chat
<ChatWidget client={chatClient} assistantName="Acme help" />
```

**Links into your app.** A reply can link to a screen or a record with a Markdown link whose target is a
path (`/approvals`) or a hash route (`#notes/5`). Pass your router's navigate as `onNavigate` and those
links move within the app (the widget closes first). Links to other sites still open in a new tab, and
`//host` links are refused. Tell the assistant to link instead of quoting ids: give tools a `link` field
and say so in the system prompt.

**Follow-ups and decorated replies.** Under the latest reply, `followUps` offers chips to carry on: by
default the starter `suggestions` not yet asked in this chat. Pass a list, a function of the reply (its
`tools` say what it was about), or `false`. `decorateReply` changes how a reply shows and adds something
under it. `@xano-sdk/agents/react`'s `decorateApprovalReply` turns an `approval_id: 12` line into that
request's approval card, so a person approves right in the chat.

To open it from your own control instead of a floating button (a header "Ask" button, so nothing covers
the page), pass `launcher="none"` and call `openChatWidget()` from the control.

The launcher sits 1 rem (1.5 rem from `sm`) above the bottom edge, plus `--chat-offset`. Set that CSS
variable when something else owns the bottom of the screen, such as a phone tab bar:
`:root { --chat-offset: 3.5rem; }`.

What it already gets right, from the rest of this README:

- **Rendering:** assistant replies are Markdown, through a built-in renderer that builds React elements
  and never HTML strings. Raw HTML stays text, and only `http(s)`/`mailto` links become links (new tab,
  `noopener noreferrer`). The person's own turns are plain text.
- **Sending:** one send in flight per thread; the person's turn shows at once, with a "thinking"
  indicator. After a `500` it re-reads the transcript, because the turn may already be stored, and gives
  the typed text back.
- **Errors:** `401` calls `onUnauthorized`, `404` refreshes the list, and `429` asks the person to wait.
  Every error is said in plain words.
- **Tools:** the tools a reply used (`tool_calls`) show as small chips under it.
- **Chats:** start a new chat, delete with a confirm, search once there are several, and copy a reply.
- **Composer:** grows as you type. Enter sends, Shift+Enter adds a line, and it's safe for IME typing.
- **Look:** self-contained, with no app imports and no Markdown or icon packages. It's styled with
  shadcn/ui's theme tokens, so in a shadcn/Tailwind app it takes your theme and dark mode. With
  Tailwind v4: `@source "../node_modules/@xano-sdk/chatbot/dist";`.

**Guests** (`registerChatbot(…, { guest: true })`): `createChatClient({ apiBaseUrl, guest: true })`. The
client keeps each thread's `session_token` in memory, or in sessionStorage with
`guestStorage: "session"`, and never in localStorage. After sign-in, claim the threads:
`for (const t of guestClient.guestThreads()) await userClient.claim(t.id, t.session_token)`.

Build your own instead with `useChat(client)` (the state, serialized sends and error handling) and
`<Thread chat={…} />`, or just `<Markdown text={reply} />`.

## Endpoints

Paths below assume the default `routePrefix: "chat"`.

### Authenticated (`{ authenticated: true }`, the default)

Every endpoint takes `Authorization: Bearer <token>` for `authTable` and is scoped
to `auth("id")`.

| Verb | Path | Returns |
|---|---|---|
| POST | `chat/conversations/create` | the new conversation |
| GET | `chat/conversations` | the caller's conversations, most recently active first |
| GET | `chat/conversations/{conversation_id}/messages` | the transcript, oldest first |
| POST | `chat/conversations/{conversation_id}/send` | `{ conversation_id, reply, message_id, tool_calls }` |
| DELETE | `chat/conversations/{conversation_id}` | `null` |
| POST | `chat/conversations/{conversation_id}/claim` | the claimed conversation *(only with `guest: true`)* |

### Guest (`{ guest: true }`, off by default)

Public endpoints scoped by an unguessable `session_token` instead of a login.
**Read [Guest threads are protected by a bearer capability](#guest-threads-are-protected-by-a-bearer-capability) before enabling this.**

| Verb | Path | Returns |
|---|---|---|
| POST | `chat/guest/conversations/create` | the conversation **plus its `session_token`** |
| GET | `chat/guest/conversations/{conversation_id}/messages` | the transcript |
| POST | `chat/guest/conversations/{conversation_id}/send` | `{ conversation_id, reply, message_id, tool_calls }` |
| POST | `chat/guest/conversations/{conversation_id}/delete` | `null` |

Guest endpoints take `session_token` as a parameter. The delete is a `POST`
rather than a `DELETE` on purpose: a `DELETE` would have to carry the token in
the query string, and a URL travels into access logs, proxies and `Referer`
headers.

### Why the routes are not RESTful verb pairs

The SDK composes a query's identity from `(api group, verb, name)`, and
`xanosdk routes --emit` keys its manifest on `"<VERB> <name>"`, so a verb pair on
one name is legal. The names here stay as they are anyway: a query's identity
includes its name, so renaming one moves its identity and every consumer's
`xano.lock` with it. `create` / `send` also read as Xano-idiomatic, the same shape
as `auth/signup` and `auth/login`.

## Authenticated *and* anonymous, in one install

```ts
registerChatbot(xano, { authTable: userTable, guest: true });
```

A visitor chats before signing up; after they log in, the client calls
`chat/conversations/{id}/claim` with the `session_token` it held, and the thread
becomes theirs. Claiming sets `user_id` and thereby **ends the token's
authority** — the guest endpoints reject it from then on, so logging in does not
leave a second, weaker credential valid against the thread.

These are two endpoint families rather than one flexible family because Xano
endpoints enforce authentication at the endpoint level (`auth` is binary). In
public endpoints, accessing authentication context raises `ACCESS_DENIED` rather
than resolving to null. Providing separate authenticated and guest endpoints
ensures clear access rules and security boundaries, while both delegate to a
single shared reply function.

## The agent

`llm` is passed straight through to the SDK's `agent({ llm })`, minus the run
prompt. It defaults to `{ type: "xano-free" }` — Xano's keyless provider — so a
fresh install answers a message with no credential wiring at all. Swap in a keyed
provider whenever you like:

```ts
registerChatbot(xano, {
  authTable: userTable,
  llm: {
    type: "anthropic",
    model: "claude-opus-5",
    apiKey: "{{ $env.ANTHROPIC_API_KEY }}",   // env var, not a literal in the bundle
    systemPrompt: "You are a support agent for Acme. Never discuss pricing.",
  },
});
```

**`llm.prompt` and `llm.messages` are rejected**, at compile time and again at
runtime. This package owns the run prompt because that is how the transcript
reaches the model, and Xano stores exactly one prompt behind a `prompt_type`
discriminator — so a supplied prompt would *replace* the history rather than add
to it. Put your instructions in `systemPrompt`.

### How history reaches the model

The send endpoint reads the last `historyLimit` turns, projects them to
`[{ role, content }]`, JSON-encodes them, and hands the result to the agent's
`messages` template. The engine decodes it back into native LLM message roles.

Using structured message roles allows the model to process conversation history
natively rather than relying on unstructured text interpolation, optimizing token
efficiency and preserving role boundaries.

To maintain conversation integrity:
- `role` is constrained to an enum (`["user", "assistant", "system"]`).
- `content` requires a non-empty string (`min: 1`) and is automatically trimmed
  so blank or invalid turns cannot enter the history.

## Options

| Option | Default | Notes |
|---|---|---|
| `authTable` | — | Required unless `authenticated: false`. A `table()` handle or a table name. |
| `userIdType` | `"int"` | The primary-key type of `authTable`. Only needed with a bare name. |
| `authenticated` | `true` | Register the token-authenticated family. |
| `guest` | `false` | Register the public guest family. |
| `llm` | `{ type: "xano-free" }` | Provider settings; `systemPrompt` is the field most installs set. |
| `historyLimit` | `20` | **Messages** replayed to the model per send, including the current one. |
| `listLimit` | `100` | Conversations returned by the list endpoint. |
| `transcriptLimit` | `200` | Messages returned by a transcript endpoint. |
| `canonical` | *(unset)* | Pin the API group's URL segment so `getPath()` resolves without a lock. |
| `tools` | `[]` | Tools the agent may call. You register them; this package only references them. |
| `rateLimit` | `{ max: 20, ttl: 60 }` | Per-caller ceiling on the model-invoking endpoints; `false` disables. |
| `history` | `false` | Request-history capture. Off by default — see below. |
| `routePrefix` | `"chat"` | Leading segment of every endpoint path. |
| `names` | see below | Stored object names: `conversation`, `message`, `agent`, `apiGroup`, `replyFn`. |
| `tags` | `["xano:chatbot"]` | Tags applied to every def. |

### Request history is off by default

Xano's request history defaults **on** and records the request body. Here that
body is the user's message text and — on the guest family — the `session_token`
that grants access to the entire thread. A turnkey install should persist
neither, so `registerChatbot` sets the group's history to `false` and the
endpoints inherit it. Opt back in for local debugging:

```ts
registerChatbot(xano, { authTable: userTable, history: true });  // engine default depth
registerChatbot(xano, { authTable: userTable, history: 25 });    // capture depth 25
registerChatbot(xano, { authTable: userTable, history: "all" }); // unlimited depth
```

The depth caps how many statement executions one history record's stack trace
keeps — it is not a retention limit.

## Identity & the lock

This package pins **no** guids, and no canonical unless you ask for one.

- **With `xano.lock` (recommended):** your first locked export mints and freezes a
  guid for every object and a canonical for the API group, then reuses them on
  every later export. Repeated imports are idempotent and your API URL is stable.
  Commit `xano.lock`.
- **Without a lock:** each guid derives from its name (`md5("<kind>:<name>")`;
  a query's from its api group, verb and name) and
  the engine assigns a random canonical at import. Fine for a one-shot import.

Pin the canonical instead if you want a browser to resolve `getPath()` with no
lock file:

```ts
export const bot = registerChatbot(xano, { authTable: userTable, canonical: "chat" });
export default bot.xano;
// → sendMessage.getPath({ params: { conversation_id: 42 } })
//   "/api:chat/chat/conversations/42/send"
```

The segment must match `[A-Za-z0-9_-]+` and be unique across the instance's API
groups — which this package cannot check, so a collision surfaces at Xano import.

## Calling it from a typed client

Every request and response type is exported directly, so a client never re-types
a body. They are types, so `import type` erases them — a browser bundle pays
nothing:

```ts
import type { SendMessageBody, ChatReply } from "@xano-sdk/chatbot";

const body: SendMessageBody = { content: "Hello" };   // no conversation_id — it rides in the path
```

Names follow one rule — `<HandleName><Part>`, where the handle name is the
property on `bot.authenticated` / `bot.guest`:

| part | is | goes |
|---|---|---|
| `…Params` | path parameters | interpolated into the URL |
| `…Query` | query-string parameters | `?a=b` |
| `…Body` | the JSON body | the request body |
| `…Input` | all of the above at once (what the SDK derives) | — |
| `…Response` | what comes back | — |

A part an endpoint does not take is **not exported**, so the existence of a name
answers "does this take a body?". Never send `…Input` as the body: it contains
the path params, which the endpoint reads off the URL — that is what used to
force `Partial<…>` and throw away the check on the fields you do send.

```ts
import type { SendMessageParams, SendMessageBody, ChatReply } from "@xano-sdk/chatbot";

async function ask(token: string, conversationId: number, content: string): Promise<ChatReply> {
  const params: SendMessageParams = { conversation_id: conversationId };
  const body: SendMessageBody = { content };

  const res = await fetch(`${BASE}/api:chat/chat/conversations/${params.conversation_id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}
```

### `ChatbotEndpoints` — the whole surface as one map

Keyed by the same names as the def handles, so `bot.authenticated.sendMessage`
and `ChatbotEndpoints["sendMessage"]` describe one thing:

```ts
type Send = ChatbotEndpoints["sendMessage"];
// Send["verb"]     → "POST"
// Send["route"]    → "conversations/{conversation_id}/send"   (relative to routePrefix)
// Send["auth"]     → "token"
// Send["params"]   → { conversation_id: number }
// Send["query"]    → never
// Send["body"]     → { content: string }
// Send["response"] → ChatReply
```

Keys: `createConversation`, `listConversations`, `listMessages`, `sendMessage`,
`deleteConversation`, `claimConversation`, `guestCreateConversation`,
`guestListMessages`, `guestSendMessage`, `guestDeleteConversation`.

The map also records **where the guest bearer token travels**, which is a
security property rather than a style choice: `guestListMessages` is a `GET`, so
`session_token` rides in the query string — and therefore into access logs,
proxies and `Referer` headers — while `guestDeleteConversation` is a `POST`
*specifically* so it rides in the body instead.

### Where the URL comes from

Don't hand-type it, and **don't import a def to call `getPath()` in the browser**.
A def import is a *runtime* import: the `s.*`/`c.*` factories in its stack execute
at module load and cannot be tree-shaken, so reaching for a path costs ~236 kB
minified (~62 kB gzipped). Instead generate the routes as plain data — the file
imports nothing and a rename becomes a type error rather than a 404:

```bash
npx xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts
```

```ts
import { routePath } from "../xano/routes.gen.js";

routePath("POST chat/conversations/{conversation_id}/send", { conversation_id: 42 });
// → "/api:chat/chat/conversations/42/send"
```

Server-side, where bundle size is irrelevant, the def handle is the direct route:
`bot.authenticated.sendMessage.getPath({ params: { conversation_id: 42 } })`.

### Reaching the defs themselves

`registerChatbot` returns the def set (the instance is on `.xano`), so export it
and a client can `import type` the handle — which erases, unlike a value import:

```ts
// xano/index.ts
export const bot = registerChatbot(xano, { authTable: userTable, canonical: "chat" });
export default bot.xano;

// frontend — costs the bundle nothing
import type { bot } from "../xano/index.js";
type Send = typeof bot.authenticated.sendMessage;
```

### Render the reply as Markdown

Any frontend works — the endpoints are ordinary JSON over HTTP. But replies read
markedly better rendered as **Markdown** than as plain text, so the default system
prompt asks the model for light markdown (emphasis, lists, fenced code) and your
UI should render it. Drop it into a text node instead and the reader sees literal
`**asterisks**`.

```tsx
import Markdown from "react-markdown";

<div className="prose">
  <Markdown>{message.content}</Markdown>
</div>
```

Two things to get right:

- **Treat the reply as untrusted input.** It is model output shaped by whatever
  the user typed, so a prompt-injection attempt can try to steer it into
  `<script>` or a `javascript:` link. Keep raw HTML **disabled** — that is the
  default in `react-markdown` and `marked` — or sanitize before any
  `dangerouslySetInnerHTML`. The prompt telling the model not to emit HTML is a
  nudge, not a control; the renderer is the control.
- **Plain-text UI? Override the prompt.** If you are not rendering markdown,
  pass your own `llm.systemPrompt` without the formatting instruction, so the
  model stops emitting markup you will only have to strip.

The same applies to `role: "user"` messages from the transcript — those are
verbatim user input and should be rendered as plain text, not markdown, so one
user cannot post markup into a thread another user reads.

Only **one** response shape is declared rather than derived: the send endpoints'
`ChatReply`. `reply` is the agent run's `.result`, and the agent carries no
structured-output schema (a chat reply is free text), so the SDK's static walk
resolves it to `unknown`. Every other endpoint's response is derived from its
`output` list, so editing a `PUBLIC_*_FIELDS` array moves the consumer type with
it.

## Factories, not module-level defs

`@xano-sdk/auth` exports its defs as module singletons — `import { userTable }`.
This package cannot, and the reason is `authTable`: `f.tableRef` resolves its
target's guid **eagerly**, at column-construction time, so a module-level
`conversation` def would bake in one particular user reference the moment the
module evaluated and could never be re-pointed.

So the cherry-pick path is `createChatbot`, which builds everything and registers
nothing:

```ts
const bot = createChatbot({ authTable: userTable });

xano
  .registerTables([bot.conversation, bot.message])
  .registerAgents([bot.agent])
  .registerFunctions([bot.replyFn])
  .registerApiGroups([bot.group])
  .registerQueries([bot.authenticated.sendMessage]);    // only the endpoints you want
```

Dependencies travel together: the queries need both tables, the reply function
and the agent. The upside of factories is that the whole class of process-wide
singleton bugs disappears — two `createChatbot` calls simply produce two
independent sets, so there is nothing to reconcile between them.

### Two chatbots in one workspace

Give the second one its own `routePrefix` **and** `names`. The prefix keeps the
endpoint guids apart (a query's identity includes its route name); `names` keeps the
tables, agent, function and group apart.

```ts
registerChatbot(xano, { authTable: userTable });                 // the default set
const support = createChatbot({
  authTable: userTable,
  routePrefix: "support",
  names: {
    conversation: "support_conversation", message: "support_message",
    agent: "support_agent", apiGroup: "Support", replyFn: "support/reply",
  },
});
// …then register `support`'s defs by hand, as above.
```

Calling `registerChatbot` twice on one instance throws, rather than letting the
collision surface much later as an opaque duplicate-guid error at export.

## Concurrent sends to one thread — serialize client-side

A send operation writes the user message, retrieves conversation history,
executes the AI agent, and records the assistant reply. Because model generation
is asynchronous, concurrent sends to the same conversation thread can interleave:
multiple user turns may be written before an assistant reply returns, causing
subsequent model calls to see in-flight messages.

**Recommended client practice:** Keep one send request in flight per conversation
and disable the composer while awaiting a reply.

Transcripts are ordered by `created_at` timestamp rather than auto-incrementing ID.

## Rate limiting — ON by default

The guest family is public and every send invokes an LLM call, so `rateLimit`
defaults to `{ max: 20, ttl: 60 }` (20 requests per 60s per caller) on the
endpoints that consume resources: both `send` endpoints and
`guest/conversations/create`. Reads are not rate-limited.

```ts
registerChatbot(xano, { authTable: userTable, rateLimit: { max: 5, ttl: 30 } });
registerChatbot(xano, { authTable: userTable, rateLimit: false });  // remove it
```

The rate limiter runs first, before database lookups, so unauthorized probes
consume only the caller's request budget. Rate limit buckets are namespaced by
`routePrefix`.

Authenticated endpoints key on `auth("id")`, while guest endpoints key on
`sys.remoteIp()`.

## Limits truncate silently — there is no pagination

No read endpoint paginates. Each caps its result and returns it with no cursor
or total count: `transcriptLimit` (default 200) keeps the **newest** messages,
`listLimit` (default 100) returns the most recently active conversations, and
`historyLimit` (default 20) controls how many **messages** reach the model per
send (including the current message).

For example, with `historyLimit: 2`, the model context receives only the
immediate previous assistant message and the current user message.

Design implications:
- Do not implement pagination controls against these endpoints.
- `historyLimit` is configured independently of `transcriptLimit`. Adjust
  `historyLimit` in configuration if your assistant requires a larger memory
  window.

## Giving the agent tools

The chat agent is tool-less by default. Pass `tools` to allow the assistant to
call workspace functions and query external data on demand — passing a `tool()`
handle, a bare name, or a `{ tool, enabled?, auth? }` wrapper:

```ts
import { tool, input, s, inp, ref } from "@xano/sdk";

const orderStatus = tool({
  name: "order_status",
  description: "Look up the delivery status of an order by its id.",
  input: { order_id: input.int({ required: true }) },
  stack: [s.db.get({ table: orders, fieldName: "id", fieldValue: inp("order_id"), as: "row" })],
  response: ref("row"),
});

const bot = registerChatbot(xano, { authTable: userTable, tools: [orderStatus] });
bot.xano.registerTools([orderStatus]);   // ← REQUIRED: register tools on the workspace
export default bot.xano;
```

⚠ **You must register the tool yourself.** This package only references tools.
Registering them on the workspace ensures proper resolution at deployment.

Key behaviors when adding tools:
- **`llm.maxSteps`:** Bounds the number of reasoning/tool steps (defaults to `5`).
- **Tool authorization:** a tool has **no caller identity unless its toolset entry
  names an auth table**. With `authTable` set, this package gives every entry that
  names none `auth: <authTable>`, so `auth("id")` inside the tool binds the
  chatting user. Read *Per-tool auth* below before writing `auth()` in a tool.
- **Transcript context:** Tool outputs returned to the model become part of the
  conversation context. Ensure tools return concise, relevant data.

### Per-tool auth

A toolset entry carries its own `auth`, and the engine's default is `auth: false`
— a **public** tool stack. `auth("id")` in a public stack does not resolve to
null; it raises `ERROR_CODE_ACCESS_DENIED` on the first statement that reads it.
The agent swallows the throw, so the model answers "I saved that note", nothing
is written, and no surface a client can reach reports a failure.

That failure cost a full debugging session on a real build, so the default moved.
When `authTable` is set, every tool entry that names no `auth` of its own is given
that table:

```ts
tools: [saveNote]                         // → { tool: saveNote, auth: userTable }
tools: [{ tool: saveNote }]               // → { tool: saveNote, auth: userTable }
tools: [{ tool: saveNote, auth: other }]  // → left alone
tools: [{ tool: ping, auth: false }]      // → left PUBLIC — the explicit opt-out
```

- `{ tool, auth: false }` is now the only spelling that produces a public tool. A
  tool written that way must not call `auth()` — scope what it reads by the
  arguments the model supplies.
- A **guest-only** bot (`{ authenticated: false, guest: true }`) has no auth
  table, so nothing is scoped and `auth()` cannot work in its tools at all.
- **Both families at once** is a hazard this package cannot resolve for you: one
  agent serves both, and an entry carries one `auth`, so a scoped tool has no
  identity to bind on a public guest send. `createChatbot` warns. Either mark the
  guest-reachable tools `{ tool, auth: false }` and keep `auth()` out of them, or
  give the guest bot its own `registerChatbot` install with its own
  `routePrefix`, `names` and tools.

### What a client sees when a tool runs

**The API contract remains identical.** Whether tools are enabled or not:

| | with tools | without tools |
|---|---|---|
| `send` response | `ChatReply` — `{ conversation_id, reply, message_id, tool_calls }` | identical |
| `reply` | a plain string, formatted as Markdown | identical |
| `tool_calls` | the **names** of the tools that ran, in call order | always `[]` |
| transcript rows added per send | **2** — the user turn and the final answer | 2 |
| tool calls in the transcript | **none** | — |

A client interacting with the chatbot uses the exact same interface: calling
`send` returns the final answer in `reply`, and the stored transcript contains
clean user and assistant turns.

`tool_calls` is always an array of strings, never null, so
`reply.tool_calls.length` needs no branch on how the bot was configured. Names
only, and deliberately: a call record also carries the arguments the model
produced and whatever the tool returned, which is data no client asked for.

⚠ It is **not an audit log**. It reports which tools the model reached for on
this run, not which of them succeeded. To know a tool worked, read the rows it
should have written.

Key considerations when enabling tools:
- **Execution loop:** The agent iterates (calling tools and evaluating responses)
  until generating a final reply, bounded by `llm.maxSteps` (default `5`). All
  tool calls complete within the single `send` request.
- **Latency:** Tool execution adds to request duration. Keep tool functions
  fast and keep `maxSteps` bounded to your use case.
- **Client visibility:** `tool_calls` names what ran; the arguments, results and
  intermediate turns stay server-side and are not written to
  `conversation_message`.
- **Security:** Model output remains untrusted content. Keep raw HTML disabled
  in frontend renderers.

### The model has to be told the tools exist

When `tools` are configured, this package automatically appends instructions to
the system prompt:

> You have tools available. When a question needs information you do not have,
> call the appropriate tool rather than guessing or saying you do not know. Use
> what a tool returns to answer in your own words — never paste the raw tool
> response or its wrapper into your reply.

This ensures the model proactively executes available tools when needed and
translates raw tool response structures into natural language replies. Exported
as `TOOLS_SYSTEM_PROMPT` for reference or reuse.

### Structured output is deliberately not configurable

`AgentDef` supports an `output` schema; this package pins none and exposes no
option for it. `ChatReply.reply` is declared `string` and the send endpoints hand
`run.result` straight back, so a structured-output schema would make `.result` an
object where every consumer's type — and every markdown renderer — expects text.

If you want structured data out of a conversation, give the agent a **tool** that
records it and keep the reply itself free text. That also keeps the thing the
user reads and the thing your system stores from competing for one field.

## Errors

Common HTTP status codes returned by the chatbot endpoints (wrapped in Xano's
standard `{ code, message, payload? }` envelope):

| status | `code` | when | client should |
|---|---|---|---|
| `400` | `ERROR_CODE_INPUT_ERROR` | a required param is absent or empty | fix the request; not retryable |
| `401` | `ERROR_CODE_UNAUTHORIZED` | no token, or invalid/expired (tokens last 24h) | sign out and re-authenticate |
| `403` | `ERROR_CODE_ACCESS_DENIED` | a guest token on a claimed thread; duplicate claim attempt | stop using the session token; prompt to sign in |
| `404` | `ERROR_CODE_NOT_FOUND` | thread missing, not owned by user, or invalid guest token | treat the thread as unavailable; refresh list |
| `429` | `ERROR_CODE_TOO_MANY_REQUESTS` | rate limit exceeded | back off and retry after the window |
| `500` | — | agent execution failure or empty reply | retryable; user turn may already be recorded |

Key behavior notes:
- **Unified 404s for security:** A non-existent conversation and an unauthorized
  conversation both return `404 Not Found` to prevent conversation ID enumeration.
- **Empty parameter handling:** Empty strings (`""`) are treated as missing
  parameters and return `400 Bad Request`.
- **Automatic trimming:** User message `content` is automatically trimmed before
  storage and processing. Whitespace-only messages are rejected with `400`.

## Security notes (read before production)

### Guest threads are protected by a bearer capability

Whoever holds a `session_token` can read and continue that conversation. It is
minted by `security.create_uuid`, stored in an `internal` column, and returned
exactly once — by the create endpoint, from that statement's own binding; no
endpoint ever reads it back out to a caller. Even so:

- It travels in a request parameter on every guest call, so it lands in anything
  that logs request bodies. (This is why request history defaults off.)
- A client that persists it in `localStorage` has persisted a credential.
- It has no expiry. Claiming a thread ends its authority; nothing else does.

If that trade is wrong for your site, leave `guest` off and require a login.

### What the guards do and do not cover

- A **missing** thread and **someone else's** thread both return `notfound`. An
  `accessdenied` on a thread that exists but is not yours would confirm its
  existence to anyone enumerating ids.
- Nothing here rate-limits reads. Rate limits apply to writes and AI invocations.
- Nothing here moderates input or output. The model sees user text verbatim, and
  its reply is stored and served verbatim.
- `historyLimit` bounds the context window per turn, but a conversation grows
  without limit and there is no pruning or retention mechanism. You own the
  lifecycle of both tables.
- Deleting a conversation deletes its messages first; the foreign key is a
  reference, not a database cascade, so nothing else collects them.

## Versioning & Compatibility

- `@xano/sdk`: `>=1.0.0 <2.0.0` peer dependency (built and tested against `1.0.0`).
- Node.js: `>=20`.
- Module format: ESM-only.

## License

MIT
