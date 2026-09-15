# unshit your comments

Most comments in a codebase are landfill. Restatements of the line below them. Notes from a code
review that ended two years ago. `// increment i`. Someone's TODO from a job they've since left.
A four-paragraph block explaining a function that no longer exists in that shape.

This thing finds all of them and deletes them.

It's not a linter and it's not a formatter. It parses your tree, pulls out every comment, breaks
each one into atomic factual claims, and then argues against each claim until only the ones that
actually earn their place survive. Then it rewrites the comment from *those* — not as a summary of
what was there, but as a reconstruction from the parts that passed.

The bar is deliberately brutal. A fact doesn't get to stay because it's true, or useful, or
interesting. It stays only if deleting it would make a competent engineer break something.

## Heads up

This deletes things. On purpose. Aggressively. That's the entire point, and if you want a tool that
gently tidies your prose you want a different tool.

So: **review the result in `git diff`.** That's the whole review story — real diff, real
context, `git add -p` to keep the parts you like, `git restore .` to throw the lot away. Don't
wire it into a pre-commit hook and walk away.

Which means you need a baseline, not a clean tree. Uncommitted work is fine — `git add -A`
first and the diff afterwards is the tool's edits and nothing else, while `git restore .` drops
those and leaves your staged work alone. Running it on a refactor you haven't committed yet is
the normal case, not the risky one; the risky one is running it with unstaged changes, where
your deletions and its deletions end up in the same diff.

## Setup

You need [Bun](https://bun.sh) and an Anthropic API key.

```sh
bun install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run it

One command. Point it at a file, a directory, or the repo.

```sh
bun src/pipeline/run.ts src/some-file.ts
```

It scans, judges, and prints what it wants to do:

```
scanned 1 files, found 3 comments

demo.ts:1:1  DELETE (critic)
  - // Helper to add two numbers together.
  - // Added in PR #42 after review feedback from the team.

demo.ts:4:17  DELETE (transformer)
  -  // add them

demo.ts:7:1  REWRITE (critic)
  - /**
  -  * Formats a name.
  -  *
  -  * We call trim here because the upstream form submits a trailing newline, and the backend
  -  * rejects it, which used to break signup, so please do not remove the trim call.
  -  */
  + /** The upstream form submits a trailing newline that the backend rejects. */

comments considered: 3
decided: 3
to delete: 2
to rewrite: 1
to review: 0
saved: .deslop/verdicts.json
nothing written. Apply exactly this with: --replay --write
```

Each entry says who decided it — `(transformer)` or `(critic)` — so you can tell a first-pass cut
from a second-pass one.

Happy with it?

```sh
bun src/pipeline/run.ts --replay --write
```

**Use `--replay`, not a second full run.** Judging costs two model requests per batch and it isn't
deterministic, so re-running charges you again *and* gives you different answers — you'd be
applying verdicts you never read. `--replay` applies the exact ones you just read, for free.

If you already trust it, skip the preview:

```sh
bun src/pipeline/run.ts src/ --write
```

### What lands in `.deslop/`

Every judging run drops two files there: the scan (`report.json`) and the verdicts
(`verdicts.json`). `--replay` reads both. The verdicts are also where the reasoning lives — each
one carries a `dropped` array listing the propositions the two passes threw away and why, which is
the one thing a diff can't show you. Handy when you're staring at a deletion in `git diff` going
"hang on, why?".

It's in `.gitignore`. `--artifacts <dir>` moves it, `--no-artifacts` turns it off (and throws the
reasoning away with it).

### Scanning on its own

The scanner is still a standalone command if you want the raw comment inventory:

```sh
bun src/scanner/scan.ts . --out report.json --stats
bun src/pipeline/run.ts --report report.json
```

Useful for judging the same scan twice with different models without re-parsing the tree.

### From Claude Code

`SKILL.md` is at the root of this repo, so installing it *is* cloning it:

```sh
git clone https://github.com/electfreak/deslop-comments ~/.claude/skills/deslop-comments
cd ~/.claude/skills/deslop-comments && bun install
```

The directory name is the command name, so that gives you `/deslop-comments` in every project
on the machine, and `git pull` updates it. `bun install` is a one-off: the repo ships source,
not `node_modules`.

The skill finds its own directory through `${CLAUDE_SKILL_DIR}`, so it doesn't care where you
put it or what your working directory is when you call it.

The skill is a launcher and nothing more. It checks you're on Bun, in a git repo with your
work staged, and a key set — offering `git add -A` if it isn't — then runs the command against
*your* working directory and relays what came back, including the `review` lines, which don't
appear in the diff because nothing was changed. It won't second-guess the verdicts or edit
them; that's what your diff is for.

To hack on it, point a symlink at your checkout — `ln -s "$PWD" ~/.claude/skills/deslop-comments`
— and `SKILL.md` edits apply without a restart.

## Flags worth knowing

**`src/scanner/scan.ts`**

| | |
|---|---|
| `--out <file>` | write the report somewhere instead of stdout |
| `--lang ts,go` | only these languages |
| `--exclude <parts>` | drop paths containing any of these substrings |
| `--min-chars <n>` | ignore comments shorter than n characters |
| `--no-trailing` | ignore `code(); // like this` |
| `--no-git` | walk the filesystem instead of `git ls-files` |
| `--stats` | counts, to stderr |
| `--languages` | what it can parse |

**`src/pipeline/run.ts`**

| | |
|---|---|
| `--write` | actually edit files (default: just show me) |
| `--model <name>` | `opus`, `sonnet`, `haiku`, `fable`, or a full model id. Default `sonnet` |
| `--only <part>` | only files whose path contains this. Repeatable |
| `--batch-size <n>` | comments per request, default 40 |
| `--concurrency <n>` | requests in flight, default 4 |
| `--no-critic` | skip the second pass. Faster, cheaper, softer |
| `--report <file>` | judge an existing scan instead of scanning. `-` for stdin |
| `--apply <file>` | apply saved verdicts without calling the model |
| `--replay` | shorthand for the report and verdicts in `.deslop/` |
| `--artifacts <dir>` | where to save them, default `.deslop` |
| `--no-artifacts` | save nothing |
| `--lang`, `--exclude`, `--min-chars`, `--no-git` | passed through to the scan |
| `--quiet` | summary only, no preview |

## How it actually decides

Two passes, because one model asked to be ruthless will still talk itself into keeping things.

**The transformer** takes a batch of comments with their surrounding code. For each one it
decomposes the text into atomic propositions, marks each `KEEP` or `DELETE` with a reason, notes
when one proposition is redundant because another already implies it, and then reconstructs a
comment from the survivors. Output: `DELETE`, `REWRITE`, `KEEP`, or `REVIEW`.

**The critic** then gets the *rewritten* comment and is told to assume it's still too verbose. It
challenges every remaining clause independently. It doesn't know or care which words the
transformer picked. Output: `ACCEPT`, `DELETE`, `REWRITE`, or `REVIEW`.

**The merge** is a table, not a vibe:

| transformer said | critic said | what happens |
|---|---|---|
| DELETE | *never asked* | gone |
| REVIEW | *never asked* | left alone, reported to you |
| KEEP | ACCEPT | untouched |
| REWRITE | ACCEPT | transformer's version |
| KEEP or REWRITE | DELETE | gone |
| KEEP or REWRITE | REWRITE | critic's version |
| KEEP or REWRITE | REVIEW | left alone, reported to you |

Both models answer through a JSON schema enforced server-side, so "the model returned prose instead
of JSON" isn't a failure mode you have to think about.

`REVIEW` is the escape hatch. When a model says the surrounding context isn't enough to judge
safely, that comment is printed with its reason and **never edited**. Those are the ones to read.

## Things it refuses to do

It would rather skip than mangle:

- **A file that changed since the scan** is skipped whole. The report holds byte offsets; if the
  file moved under them, applying would corrupt it. Re-scan and go again.
- **A block comment with delimiters it doesn't recognise** won't be rewritten. Deleting one is
  fine — that needs no delimiters — but it won't invent an opener and closer it isn't sure about.
- **Your formatting.** Rewrites re-use the marker and indentation found in the *file*, not whatever
  the model felt like emitting. `//` stays `//`, `/**` stays `/**`, a starred block keeps its stars,
  your indentation survives.
- **Code.** It only ever touches comment spans. Both prompts say so explicitly, and the applier
  physically can't write outside the span the parser reported.

Trailing comments stay on their line. Own-line comments take their whole line with them, so you
don't get a graveyard of blank lines.

## What it reads

32 file types. Real parsing via tree-sitter for javascript, typescript, tsx, java, kotlin, scala,
c, cpp, csharp, objc, go, rust, swift, dart, php, python, starlark, ruby, lua, toml, json, css,
html, vue and svelte — so a `//` inside a string or a regex isn't a comment, and a nested block
comment is one comment.

In html, vue and svelte the script and style blocks are parsed again with the typescript and css
grammars, so `//` comments inside `<script>` are found alongside the `<!-- -->` ones in the markup.

Seven more (shell, yaml, scss, sql, groovy, xml, properties) have no grammar and get a
small hand-written lexer instead. It knows the markers and the string forms. It does not know
heredocs.

Only actual comment nodes count, which means Python docstrings are left alone. They're code.

## Poking at it

There's an offline self-check for everything that doesn't cost money — the merge table, the
renderer, the staleness guard:

```sh
bun src/pipeline/check.ts     # 28 checks, zero API calls
npx tsc --noEmit
```

## Rough edges, stated plainly

- Two model calls per batch. On a big repo that's real money. `--only` and `--min-chars` are your
  friends, and `--no-critic` roughly halves it.
- Judging isn't deterministic, so the same file twice can give you two different answers. That's
  why the verdicts get saved and `--replay` exists; don't re-run when you meant to re-apply.
- The scanner's `before`/`after` context is the nearest lines of code, not the enclosing
  declaration. Good enough almost always; occasionally why a comment lands in `REVIEW`.
- It has opinions about your comments. You may disagree with some of them. That's what `git diff`
  and `git add -p` are for.
