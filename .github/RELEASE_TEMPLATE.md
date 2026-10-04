<!--
  Release notes template for @xano-sdk/chatbot.

  Copy the body below (from the summary paragraph down), fill it in, and paste
  it into the GitHub release. HTML comments like this one are stripped before
  the Slack announcement is built and are invisible on the rendered release
  page, so the guidance can stay in the draft while you write.

  Release title (the GitHub release `name`, not the tag):

      vX.Y.Z — Three-to-five word theme

  It becomes the Slack message header verbatim, so it has to stand alone:
  "v2.0.4 — The audit fixes", not "v2.0.4" and not "Release 2.0.4".
  Hard cap 150 characters.

  How the body reaches Slack (.github/scripts/slack_release_message.py):

    - Everything BEFORE the first `##` is the summary block. Budget ~1200
      characters; past that it is clipped at a paragraph or sentence break.
      Keep the summary + install snippet under that and it posts whole.
    - Every `##` heading becomes one bullet under "In this release". The
      first 8 are shown, the rest collapse to "…and N more". So the headings
      ARE the itemized change list — write each one as a claim that survives
      on its own, with no body text under it for context.
    - Headings that are pure structure — Notes, Misc, Other, Compatibility,
      Verification, Housekeeping, Credits, Full changelog — are dropped from
      the bullets. Use them freely for real structure; just don't hide a
      change under one.
    - Bold, links, and inline code carry over. Images are dropped and tables
      are flattened to bullets — avoid both above the first heading.
    - `**Full changelog**` lines and Claude Code attribution are stripped.

  Verify a draft renders before publishing:

      cd .github/scripts && python3 test_slack_release_message.py

  That test renders this template through the real builder, so a change to
  either one has to keep the other working.
-->

<!--
  Summary: one paragraph, 2-4 sentences. What this release is about and why
  someone should take it. No story, no changelog restatement — the headings
  below do the itemizing. If there is a single behavior break, say so here.
-->

SUMMARY PARAGRAPH.

```bash
npm install @xano-sdk/chatbot@X.Y.Z
```

<!--
  One `##` per change. The heading is the title — a specific claim, not a
  category ("A bare tool handle attached no tool", not "Agent fixes").
  Under it: what was wrong or what is new, what it does now, and anything a
  user has to act on. Two or three sentences is usually right; a short code
  block when the fix is a call-site change.

  Group several small related fixes under one heading with `**Bold lead-in.**`
  paragraphs rather than spending a heading — you only get 8 Slack bullets.

  Mark anything that can break an existing build with ⚠️ in the heading.
-->

## First change, stated as a claim

What it did, what it does now, and what you have to change. Include a code
block when the fix is at the call site:

```ts
example({ before: "…", after: "…" })
```

## Second change, stated as a claim

Description.

## ⚠️ A change that can break an existing build

What breaks, for whom, and the migration. Lead with the breakage.

<!--
  Optional trailing structure — these do not consume a Slack bullet.
-->

## Notes

Anything worth recording that isn't a change: limits now stated rather than
discovered, docs that moved, known gaps.
