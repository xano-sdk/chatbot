# AGENTS.md

Instructions for coding agents (and humans) working **on** this repository.
For agents *consuming* the published package, see [llms.txt](llms.txt) instead.

## What this is

`@xano-sdk/chatbot` ships a working conversational AI assistant as typed
[Xano SDK](https://www.npmjs.com/package/@xano/sdk) defs: two tables, a Xano AI
agent, one shared reply function, and two endpoint families. It exports plain def
objects; there is **no runtime** — the consumer's `Xano` instance registers and
encodes them. Everything is verified at the compiled-output level.

## Commands

```bash
npm run build       # tsup → dist/ (esm + d.ts)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # tsc --noEmit && vitest run (type-level tests need the typecheck)
```

Run `npm run typecheck && npm run lint && npm test` before committing.

### Never widen a stack

A query's `stack` must be a literal tuple. Two things silently destroy it:

- a helper returning `Statement[]`, spread into the stack;
- a conditional spread — `...(cond ? [x] : [])` — even inline.

Either one collapses the tuple, so every `as`/`ref()` in that stack (including
ones declared *after* the spread) resolves to `unknown` and the query's response
infers as `StackTupleWidened`. **Nothing in this repo fails when that happens** —
the bundle stays byte-identical and every runtime test passes. It surfaces only in
a consumer's typecheck, as a response type that quietly became useless.

Use `statements(...)` from core for a helper, and two explicit `statements(...)`
branches for a conditional. `test/types.test.ts` → "no endpoint's response is
widened away" is the regression guard; it asserts the negative directly, because
the positive is invisible here. A conditional spread inside a statement *field*
(e.g. `db.add`'s `data`) is fine — no inference depends on it.

## Layout

- `src/options.ts` — the public option surface and `resolveOptions`, the single
  validation gate. Every check lives there, before any def is built.
- `src/tables/*.ts`, `src/agent/*.ts`, `src/functions/*.ts`, `src/api/*.ts` — def
  **factories**, one kind per module (the two endpoint families are one module
  each; see below).
- `src/register.ts` — `createChatbot(opts)` builds everything;
  `registerChatbot(xano, opts)` builds and registers, returning the same def set
  with the instance on `.xano`. It must keep returning the defs: they are
  factories, so that handle is a consumer's only route to the registered defs and
  the only way a frontend can derive types without a runtime def import.
- `src/api/client-types.ts` — the per-endpoint request/response types consumers
  import. Derived from the query handles via `ReturnType<typeof …Queries>`, which
  is purely type-level, so nothing is built and nothing reaches a bundle.
- `src/index.ts` — the public surface.
- `test/*.test.ts` — encode-level fidelity assertions.
- `test/bundle.test.ts` + `test/fixtures/golden-bundle.json` — the byte-exact
  bundle contract.
- `test/published-docs.test.ts` — the tarball contract.
- `scripts/regen-golden.ts` — regenerates the fixture (`npm run fixture:regen`).

## Facts verified against a live instance

These were established by deploying probes to an ephemeral, not read from
documentation. Several are load-bearing and **not obvious from the SDK's source**,
so re-verify before changing anything that depends on them.

### Agent tools work on ephemeral environments and instance workspaces

_Not yet re-probed on `@xano/sdk` 1.0.0._

Verified end-to-end: the chat agent calls tools through the ordinary `send`
endpoint and returns their values across both live ephemeral deploys
(`xanosdk deploy`) and instance workspaces. `s.tool.call` works as well.

(Note: An earlier ephemeral environment issue where toolsets were reported
missing or disabled has been resolved in the engine).

### A tool the model is not told about is never called

With tools attached but no mention of them in the system prompt, the model
answered "I do not know the secret word" and never called the tool — the default
prompt's "say so rather than guessing" steers it away. Asked by name ("call the
probe_secret_word tool") it called it immediately and returned the value.

Hence `TOOLS_SYSTEM_PROMPT`, appended by `resolveOptions` whenever `tools` are
configured, to the caller's own prompt as well as the default.

### Concurrent sends to one thread interleave (verified 2026-08-17)

Five parallel sends to one conversation produced the role pattern `uuuuuaaaaa`,
not `uauauauaua`: every user turn was written before any assistant turn, so each
model call read a history containing the other in-flight messages and replied to
several at once. Nothing was lost (10 rows, `created_at` non-decreasing) and no
guard failed — the send path simply has no per-thread lock, and cannot cheaply
have one across a slow model call.

Row ids were also NOT monotonic with `created_at` under that load, which is worth
remembering before writing any id-ordering assumption into a test or a stack.

Treated as a documented client-side responsibility (serialize sends per thread),
not a server fix. Revisit only if a cheap per-conversation lock appears.

### An empty string is rejected as a MISSING param (re-verified 2026-08-17)

`input.text({ required: true })` refuses `""` exactly as it refuses an absent
param — `400 ERROR_CODE_INPUT_ERROR`, `"Missing param: <name>"`, **before the
stack runs**. Checked on all three guest endpoints, query-string and JSON-body
forms alike.

This CONTRADICTS the earlier finding that `required: true` accepts an empty
string, which is why `capabilityGuard`'s first precondition exists. The
precondition is therefore currently unreachable. It is kept on purpose — see the
comment at `src/api/guest.ts`. Re-verify before acting on either result: this is
engine behaviour that has already changed once.

### The engine really does decode the `messages` template into LLM roles

Two otherwise-identical agents, one `prompt` and one `messages`, same payload:

| payload | `prompt` | `messages` |
|---|---|---|
| valid `[{role,content}]` | works, 110 input tokens | works, **89** |
| plain text, not an array | works | `ERROR_FATAL` |
| malformed JSON | works, echoes syntax back | `ERROR_FATAL` |
| `[]` | works | `ERROR_FATAL` |
| role outside the provider's set | works | `ERROR_FATAL` |
| `system` role in the array | — | works, and is honored |
| extra keys (`id`, `created_at`) | — | ignored |

The refusals are the proof — a literal string cannot be malformed — and the token
gap is the quantitative version: JSON punctuation and the `"role"`/`"content"`
keys never reach the model. **Do not "simplify" the agent to `prompt`.**

### An empty `content` does not error — it confabulates

A blank user turn produced a reply inventing an entire fictional prior exchange
about correcting the word "mispelled". This is why `content` carries `min:1` at
the column and a precondition in the reply function. A confabulated turn written
into the transcript poisons every later turn's context, and nothing surfaces it.

### `auth` on a query is binary, and `auth()` in a public stack raises

| endpoint | request | result |
|---|---|---|
| `auth` set | no token | `401 Unauthorized` |
| public | no token | `auth()` → `ACCESS_DENIED` |
| public | **valid** token | `auth()` → `ACCESS_DENIED` |

Older SDK docs said `auth()` is `null` on a public endpoint; it is not — it raises
(the SDK now documents this).
This is the entire reason there are two endpoint families. **Do not merge them.**

### A tool with no per-tool `auth` is a PUBLIC stack, and fails in silence

The most expensive defect this package has shipped (live build log,
2026-08-31). Eight tools were passed the way every other SDK collection takes
handles — `tools: [saveNote]` — and everything downstream looked right: the
bundle carried all eight against the agent with resolved guids and
`enabled: true`, and the deploy succeeded. Then every tool threw
`ERROR_CODE_ACCESS_DENIED` on its first statement, the agent swallowed the
throw, and the model answered *"I saved a note that the office door code is
4821"* while nothing was written.

The cause is the row above: a bare handle encodes `auth: false`, a bare handle
is therefore a PUBLIC tool stack, and `auth("id")` in a public stack raises
rather than resolving to null.

What made it expensive is that the failure is invisible from every surface an
agent can reach — no 500, no error in the reply, no build or export warning, and
the model's confident sentence is itself misleading evidence. Finding the error
string took a temporary `debug_event` table, a probe tool wrapping `auth("id")`
in `s.try_catch`, a public read endpoint, and three deploy cycles.

`resolveOptions` now gives every tool entry that names no `auth` the configured
`authTable` (`src/options.ts` → `applyDefaultToolAuth`), so the bare form works.
`{ tool, auth: false }` is the explicit opt-out and the only spelling that still
produces a public tool. Enabling both endpoint families with scoped tools warns:
one agent serves both and an entry carries one `auth`, so a scoped tool has no
identity to bind on a public guest send.

**Verified on ephemeral `emed-ivuz-9b4e`, 2026-09-01** — `local-files/probe/`
reproduces the log's shape exactly (bare handles, `auth("id")` as each tool's
first statement). Through the ordinary `send` endpoint: "Save a note that the
office door code is 4821" now WRITES the row, with `user_id` bound to the
caller. A second user asking the same agent to list their notes gets `[]` and
the row of the first user is invisible to them, so the scoping is real and not
merely present in the bundle.

### Tool calls live in `steps[].content[]` — the top-level `toolCalls` is always empty

From the same log. `ChatReply.tool_calls` was null on every send, which reads as proof
that no tool ran — the worst possible answer during the debugging session above,
where every tool HAD run and thrown.

The response bound `ref("run.tool_calls")`, a key the agent-run envelope does not
carry. Core types the envelope as `AgentRunResult` — `result`, `finishReason`,
`steps`, `toolCalls`, `usage` — so `toolCalls` looked like the answer. It is not.
**Probed live (ephemeral `emed-ivuz-9b4e`, 2026-09-01): the top-level `toolCalls` is
present and always `[]`, even on a run whose tool wrote a row.** The calls are one
level down:

```jsonc
steps[0].content[0] = { "type": "tool-call",   "toolCallId": "…", "toolName": "save_note",
                        "input": { "body": "…" } }
steps[0].content[1] = { "type": "tool-result", "toolCallId": "…", "toolName": "save_note",
                        "input": { … }, "output": { "id": 2, "user_id": 2, … } }
steps[1].content[0] = { "type": "text", "text": "OK. I've saved that." }
```

So the reply function reads `run|get:"steps",[]` and loops: per step, `index_by("type")`
then `get("tool-call", [])` — both entry types carry `toolName`, so without the split
every call is reported twice — then maps to the name and `array_merge`s onto an
accumulator. Names only: a tool-result carries the tool's whole return value, which is
data no client asked for.

**`fl.map` with a JS lambda does the same job in one filter, and was verified to work.**
It is not used: core is explicit that a lambda is an escape hatch drawing on a bounded
workspace-wide worker pool, and every send in every install would pay for work four
ordinary statements express. `fl.flatten()` is not an option either — it flattens all
the way to scalar VALUES, so a list of step-content objects comes back as 15 strings.

Verified end to end through the real `send` endpoint: two `save_note` calls and a
`list_notes` in one turn returned `["save_note","save_note","list_notes"]` — order kept,
duplicates kept — and a turn the model answered directly returned `[]`.

### Route names are not verb pairs

The SDK composes a query's identity from `(api group, verb, name)`, and
`xanosdk routes --emit` keys its manifest on `"<VERB> <name>"`, so `GET foo` and
`POST foo` do not collide. The route names stay distinct and `routePrefix` stays
anyway: a query's identity includes its name, so a rename moves every endpoint's
identity and every consumer's `xano.lock` with it.

⚠ **The dev pin matters.** The golden fixture is generated against
`devDependencies`, and query guids derive from the SDK's identity rules. Bumping
the pin is a reviewed act with a real fixture diff behind it — not drift to
regenerate past.

### Reproducing any of this

```bash
xanosdk deploy ./xano/index.ts --name probe --expires-hours 2
```

If `deploy` reports `must be owner of table mvpw1_N` it is refusing to re-import
over an existing ephemeral; run `xanosdk ephemeral delete probe` (or delete
`.xano/ephemeral.json`) and deploy again to get a fresh one.

## Rules that bite

- **The defs are FACTORIES, not module singletons.** `f.tableRef` resolves its
  target's guid eagerly at column-construction time, so a module-level
  `conversation` def would bake in one auth table forever. This is the one
  structural divergence from `@xano-sdk/auth`, and everything else follows from it —
  including the *absence* of auth's ~100 lines of canonical/history conflict
  guards, which exist only because its group is a process-wide singleton. Do not
  "restore symmetry" with auth by hoisting a def to module scope.
- **`registerChatbot` still needs its WeakSet.** For a different reason than
  auth's: core's duplicate-def guard compares def *identity*, and two
  `createChatbot` calls produce distinct objects sharing names, so the mistake
  slips past core and lands at `export()` as `Duplicate object guid … shared by
  "dbo/conversation" and "dbo/conversation"` — naming neither call.
- **Nothing may import `@xano-sdk/auth`.** Not as a dependency, not as a
  peer dependency, not in an example that would make it load-bearing. `authTable`
  is the whole integration surface. A test that needs an auth table declares one.
- **References use def handles, never bare names**, inside the package. The
  *consumer* may pass a bare name for `authTable`; everything this package
  references itself (the conversation table from the message table, the reply
  function from the send endpoints) uses the handle.
- **Pin no guids, and no canonical by default.** Identity belongs to the
  consumer's `xano.lock` (fallback: `md5("<kind>:<name>")`; queries seed on
  group + verb + name). The one exception is
  the opt-in `{ canonical }`, which the consumer supplies.
- **Security defaults are not preferences.** Request history off; `session_token`
  `internal` and uniquely indexed; the blank-token precondition; `notfound` rather
  than `accessdenied` on someone else's thread; the unclaimed check on both the
  guest guard and the claim endpoint. Each has a comment naming the failure it
  prevents. Changing one needs a stated reason, not a tidier-looking stack.
- **The authenticated create mints a `session_token` when guests are on.** Not
  redundant — an omitted column takes its type default (`""`) on `db.add`, so the
  *second* authenticated create used to die on the unique index, and every
  authenticated row sharing `""` made an empty guest token match a logged-in
  user's thread. Caught live; do not remove it as dead code.
- **`DEFAULT_SYSTEM_PROMPT` asks for light markdown on purpose.** It is not
  filler: the README tells frontends to render `reply` as markdown, and that only
  works if the model is told to produce it — the two are halves of one decision, so
  do not drop the clause from one side alone. "Light" is also deliberate; a model
  told plainly to "use markdown" reaches for headings and tables in a two-line
  answer, which reads worse in a chat bubble than prose. The `ChatReply.reply`
  doc and README both carry the matching warning that a rendered reply is
  model output shaped by user input, so the renderer must keep raw HTML off.
- **`llm.prompt` / `llm.messages` are refused**, in the type and at runtime. The
  package owns the run prompt because that is how the transcript is delivered, and
  Xano stores one prompt behind a `prompt_type` discriminator, so a supplied one
  would replace the history rather than add to it.
- **Values stay explicit `c.*`, never bare literals**, matching `@xano-sdk/auth`.
  Core coerces raw literals inside some maps; keeping the tag is load-bearing
  where a constant is a magic string the engine interprets (`c.text("now")`).
- **The two endpoint families live one module each**, unlike auth's
  one-def-per-module layout. Five separate modules here would be five copies of an
  identical five-parameter factory signature; the shared authorization idiom
  (`ownershipGuard` / `capabilityGuard`) is what justifies the grouping.

## Auto-wiring

`package.json` carries a `"xanosdk"` block (`register: registerChatbot`, `returns: handle`,
`options.authTable` → `@xano-sdk/auth`'s `userTable`) that `xanosdk init --marketplace`
reads to write the registration into `xano/index.ts`. The SDK offers it only when
`@xano-sdk/auth` is also installed; otherwise it prints the call and leaves it unwired.
`test/manifest.test.ts` pins the block against the real export.

## The peer range

`@xano/sdk` is a `peerDependency` with the window `>=<floor> <2.0.0` — the floor is
currently `1.0.0` and the ceiling is the next major. `devDependencies` carries the
version actually tested, pinned **exactly** (no caret) because it is the single
version the golden fixture was generated against.

Verify the floor by installing it and running the suite, rather than copying the
number forward:

- `security.create_uuid` is the uuid helper; `create_guid` was removed and must
  not come back.
- The reply function's `responseShape: {} as ChatReply` is **load-bearing**.
  Without it, the `function.run` brand in each send endpoint carries the reply
  function's whole derived response type, which is too deep for tsup's dts emit
  (a location-less TS2589 that fails `npm run build`) and for a consumer's
  `bot.queries.map((q) => …)`. Plain `tsc --noEmit` does not catch the build
  half — run `npm run build` on every bump.

Do not raise the floor without a reason: needlessly raising it forces consumers
into an upgrade that buys them nothing. `test/helpers.ts` deliberately computes
`md5("<kind>:<name>")` itself rather than importing `deriveGuid` from
`@xano/sdk/internal` — importing it would raise the floor for every consumer to
satisfy a test.

## Versions

Versions start at 1.0.0 under `@xano-sdk/chatbot` and only 1.0.x increments for
now, regardless of the change. Do not bump unless told to.

## The golden-bundle contract

`test/bundle.test.ts` registers everything on a fresh `Xano`, calls `export()`,
and deep-equals the result against `test/fixtures/golden-bundle.json` (raw, no
normalizer). This is the peer-drift tripwire.

The golden config turns **everything** on — both families, a pinned canonical, a
keyed provider — because a tripwire only guards what it encodes. `bundle.test.ts`
has a second block asserting that coverage, so the config cannot quietly narrow.

Regenerating is a deliberate, reviewed act — never a way to make a red test pass.
A failure means the encoded bundle moved; find out *why* first.

```bash
npm run fixture:regen && git diff test/fixtures/golden-bundle.json
```

Review that diff line by line (watch guids, auth flags, stack order, output lists,
`prompt_type`) before committing.

## Release

Lockstep with the peer. For each SDK bump:

1. Read the SDK's `CHANGELOG.md` entries between the two versions, then its
   `llms.txt` diff, before touching anything — a green suite proves no encoding drift, not that the
   package still follows current guidance.
2. Move the `devDependencies` pin. Move the `peerDependencies` floor **only** if a
   new core behaviour or type became load-bearing here, and *verify* it by
   installing that version and running the suite.
3. Run `npm run typecheck && npm run lint && npm test`. Regenerate the fixture
   only if the bundle legitimately changed. An unchanged fixture is the expected
   outcome of most bumps, not a reason to look harder.
4. Re-run the live probes if anything touched the agent, the reply function, or an
   authorization guard. The encode-level suite cannot catch a change in what the
   *engine* does with the bytes.
5. Update the install notes in `README.md` **and** `llms.txt` with both numbers.
6. Ship it. Only 1.0.x increments for now, and only when told to bump.

   ```bash
   npm run release:beta    # prerelease: bumps, tags, publishes under `beta`
   ```

   The stable path does **not** bump for you — `npm run release` only publishes.
   Bump in the PR that carries the change, so the version reviewers approve is
   the version that ships:

   ```bash
   npm version patch --no-git-tag-version   # in the PR
   ```

   Then, after the PR merges, from a green tree on the default branch:

   ```bash
   git tag "v$(node -p 'require("./package.json").version')"
   npm run release
   git push --tags
   ```

   `npm pack --dry-run` should show exactly 7 files (`dist/` ×2 — no source map,
   `README.md`, `AGENTS.md`, `llms.txt`, `LICENSE`, `package.json`).
   `test/published-docs.test.ts` pins that list and checks every relative link in
   a shipped doc resolves inside the tarball.

### Release notes

Start from [.github/RELEASE_TEMPLATE.md](https://github.com/xano-sdk/chatbot/blob/main/.github/RELEASE_TEMPLATE.md) — it carries
the shape and the constraints the Slack announcement imposes, and its guidance
lives in HTML comments stripped before Slack sees them.

- The GitHub release **name** (not the tag) becomes the Slack header verbatim:
  `vX.Y.Z — Three-to-five word theme`.
- Everything before the first `##` is the summary block. No story — a brief
  paragraph and the install snippet.
- After the summary, one itemized title and short description per change. Anything
  a consumer must act on (a breaking type, a peer-range move, a migration) gets
  called out there too, not left for the reader to infer.
- **Each change gets its own `##` heading**, because those become the itemized
  Slack bullets (first 8 shown). Write each as a claim that survives with no body
  text under it. Purely structural headings (Notes, Compatibility, …) are dropped
  from the bullets, so use them freely — just never hide a change under one.

Publishing a release fires `.github/workflows/release-slack.yml`, which runs
`.github/scripts/test_slack_release_message.py` in the same job that posts, so a
malformed payload fails the workflow rather than reaching Slack. Both the builder
and that test are kept identical to `xano-sdk/sdk-dev`'s and `xano-sdk/auth`'s modulo the
repo and package names; port fixes between them rather than letting them diverge.

```bash
cd .github/scripts && python3 test_slack_release_message.py
```

## The optional frontend (`src/react/`, published as `@xano-sdk/chatbot/react`)

- **Optional and self-contained.** Nothing outside `src/react/` imports it, and it imports nothing from
  `@xano/sdk` at runtime (`import type` only), nothing from an app, and no packages but React.
  `test/react-frontend-rules.test.ts` enforces it. React is an optional peer.
- **The Markdown renderer must never produce HTML strings.** Elements only, with links limited to
  `http(s)` and `mailto`. `test/react-markdown.test.tsx` holds the injection cases; add one when you
  widen the syntax.
- **`useChat` serializes sends itself**, not only through the disabled button. A test calls `send` twice
  at once.
- It follows this README's frontend checklist. When an endpoint's shape or an error's meaning changes,
  update `src/react/client.ts` in the same change.
