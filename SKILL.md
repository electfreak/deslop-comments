---
name: deslop-comments
description: Delete unnecessary source comments with the deslop-comments pipeline. Use when the user asks to clean up, deslop, prune, or unshit comments in a file, directory, or the whole repo, or after a large refactor has left stale commentary behind.
---

# deslop-comments

A two-pass pipeline judges every comment in the requested scope and edits the source. You do
not judge comments yourself, and you do not review its verdicts. The human reviews the result
in `git diff`, which is why the preconditions below are not optional.

The tool lives in this skill's own directory, `${CLAUDE_SKILL_DIR}`. It runs against the user's
working directory, so never `cd` into the skill directory to use it — pass the path instead.

## Preconditions

Check all of these before running anything. If one fails, stop and tell the user — do not work
around it.

1. **Bun.** `command -v bun`. The tool is Bun-only; Node cannot run it.
2. **Dependencies.** If `${CLAUDE_SKILL_DIR}/node_modules` does not exist, install them once:
   `cd "${CLAUDE_SKILL_DIR}" && bun install`. A fresh install ships source, not dependencies.
3. **A git work tree.** `git rev-parse --git-dir`. Without version control there is nothing to
   review the edit against and nothing to revert to, and this tool deletes aggressively.
4. **A baseline to diff against**, which does *not* mean a clean tree. Uncommitted work is
   fine, and running on it is a normal thing to want — a refactor you have not committed yet is
   exactly where stale comments collect. What it must not be is *unstaged*. Run
   `git diff --quiet`; if it fails, offer to stage the current state with `git add -A`. That is
   not a commit, it moves no branch, and `git reset` undoes it.

   Staging is what keeps the two properties the review depends on. Afterwards `git diff` shows
   the tool's edits and nothing else, and `git restore .` reverts the tool's edits and nothing
   else — the user's own work is already safe in the index. Untracked files need staging too:
   the tool scans them, and nothing anywhere holds a copy to restore them from.

   Two cases not to steamroll. If the index already differs from HEAD *and* there are unstaged
   changes, the user has a deliberate partial stage that `git add -A` would flatten: say so and
   let them choose. If they decline to stage at all, stop — without a baseline the tool's
   deletions cannot be told apart from theirs, or undone separately.
5. **Credentials.** `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`
   for a gateway. Tell the user to export one if none is set. This spends money on whichever
   account that credential belongs to, separately from any Claude Code subscription: two
   model requests per batch of 40 comments.

## Running it

One command, from the user's working directory:

```
bun "${CLAUDE_SKILL_DIR}/src/pipeline/run.ts" <scope> --write --quiet
```

`<scope>` is what the user asked for — a file, a directory, several paths, or `.` for the whole
repo. Add `--only <substring>` to narrow further, `--min-chars <n>` to skip the short ones, or
`--model opus` if they ask for a more careful pass. Confirm the scope with the user first if
they were vague, and confirm before running on `.` in a large repository, since cost scales
with the number of comments.

It prints progress and a summary to stderr, and saves what it decided to `.deslop/` in the
user's working directory. Mention that directory once, and offer to add it to their
`.gitignore` if it is not there already.

## What to report back

Relay only these, then stop:

- the counts block (`comments considered`, `to delete`, `to rewrite`, `to review`)
- every **review** line — these comments were *not* touched, because the pipeline judged the
  context insufficient to decide safely. They are invisible in the diff, so they only exist if
  you relay them.
- every **skipped** line, and every **failed batch** line, for the same reason.
- a closing pointer: the edit is unstaged, so `git diff` shows it, `git add -p` keeps part of
  it, and `git restore .` throws all of it away while leaving anything staged beforehand
  intact. If work was staged in step 4, they will want `git add -A` again before committing.

Do not summarise the diff, do not list the deleted comments, and do not editorialise about the
edits. The diff is the report.

## What not to do

- **Do not edit `.deslop/verdicts.json`.** The pipeline judged each comment with its
  surrounding code under a prompt written for the job; you would be overriding it from a
  summary, and you would bias towards keeping, because keeping always looks safe.
- **Do not re-judge.** If the user disagrees with a specific deletion, they revert that hunk.
  If they disagree with the pattern, that is feedback about the prompts in
  `${CLAUDE_SKILL_DIR}/src/prompts/`.
- **Do not re-run to "check".** Judging is not free and not deterministic; a second run costs
  again and answers differently. To apply verdicts you already have, use `--replay --write`.
- **Do not interrupt a run.** Failed batches are collected and reported; the successful ones
  still apply.
- **Do not edit anything inside `${CLAUDE_SKILL_DIR}`.** That is the tool's own installed copy,
  and an update overwrites it. The one exception is the `bun install` above.

## Answering "why did it delete that?"

`.deslop/verdicts.json` holds one verdict per comment with a `dropped` array: the propositions
the two passes judged unnecessary, each with a reason. Read that file for the comment's id
rather than guessing, and rather than re-running the pipeline.
