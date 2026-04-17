---
name: paperclip-dev
required: false
description: >
  Develop and operate a local Paperclip instance — start and stop servers,
  pull updates from master, run builds and tests, manage worktrees, back up
  databases, and diagnose problems. Use whenever you need to work on the
  Paperclip codebase itself or keep a running instance healthy.
---

# Paperclip Dev

This skill covers the day-to-day workflows for developing and operating a local Paperclip instance. It assumes the repo lives at `~/workspace/paperclip` (or the current checkout) with `origin` pointing to `git@github.com:paperclipai/paperclip.git`.

> **MANDATORY:** Before running any CLI command, building, testing, or managing worktrees, you MUST read `doc/DEVELOPING.md` in the Paperclip repo. It is the canonical reference for all `paperclipai` CLI commands, their options, build/test workflows, database operations, worktree management, and diagnostics. Do NOT guess at flags or options — read the doc first.

## Quick Command Reference

These are the most common commands. For full option tables and details, see `doc/DEVELOPING.md`.

| Task | Command |
|------|---------|
| Start server (first time or normal) | `npx paperclipai run` |
| Dev mode with hot reload | `pnpm dev` |
| Stop dev server | `pnpm dev:stop` |
| Build | `pnpm build` |
| Type-check | `pnpm typecheck` |
| Run tests | `pnpm test` |
| Run migrations | `pnpm db:migrate` |
| Regenerate Drizzle client | `pnpm db:generate` |
| Back up database | `npx paperclipai db:backup` |
| Health check | `npx paperclipai doctor --repair` |
| Print env vars | `npx paperclipai env` |
| Trigger agent heartbeat | `npx paperclipai heartbeat run --agent-id <id>` |
| Install agent skills locally | `npx paperclipai agent local-cli <agent> --company-id <id>` |

## Pulling from Master

```bash
git fetch origin && git pull origin master
pnpm install && pnpm build
```

If schema changes landed, also run `pnpm db:generate && pnpm db:migrate`.

## Worktrees

Paperclip worktrees combine git worktrees with isolated Paperclip instances — each gets its own database, server port, and environment seeded from the primary instance.

> **MANDATORY:** Before creating or managing worktrees, you MUST read the "Worktree-local Instances" and "Worktree CLI Reference" sections in `doc/DEVELOPING.md`. That is the canonical reference for all worktree commands, their options, seed modes, and environment variables.

### When to Use Worktrees

- Starting a feature branch that needs its own Paperclip environment
- Running parallel agent work without cross-contaminating the primary instance
- Testing Paperclip changes in isolation before merging

### Command Overview

The CLI has two tiers (see `doc/DEVELOPING.md` for full option tables):

| Command | Purpose |
|---------|---------|
| `worktree:make <name>` | Create worktree + isolated instance in one step |
| `worktree:list` | List worktrees and their Paperclip status |
| `worktree:merge-history` | Preview/import issue history between worktrees |
| `worktree:cleanup <name>` | Remove worktree, branch, and instance data |
| `worktree init` | Bootstrap instance inside existing worktree |
| `worktree env` | Print shell exports for worktree instance |
| `worktree reseed` | Refresh worktree DB from another instance |
| `worktree repair` | Fix broken/missing worktree instance metadata |

### Typical Workflow

```bash
# 1. Create a worktree for a feature
npx paperclipai worktree:make my-feature --start-point origin/main

# 2. Move into it and source the environment
cd ~/paperclip-my-feature
eval "$(npx paperclipai worktree env)"

# 3. Start the isolated Paperclip server
npx paperclipai run

# 4. Do your work

# 5. When done, merge history back if needed
npx paperclipai worktree:merge-history --from paperclip-my-feature --to current --apply

# 6. Clean up
npx paperclipai worktree:cleanup my-feature
```

## Pull Requests

> **MANDATORY PRE-FLIGHT:** Before creating ANY pull request, you MUST read the canonical source files listed below. Do NOT run `gh pr create` until you have read these files and verified your PR body matches every required section.

### Step 1 — Read the canonical files

You MUST read all three of these files before creating a PR:

1. **`.github/PULL_REQUEST_TEMPLATE.md`** — the required PR body structure
2. **`CONTRIBUTING.md`** — contribution conventions, PR requirements, and thinking-path examples
3. **`.github/workflows/pr.yml`** — CI checks that gate merge

### Step 2 — Validate your PR body against this checklist

After reading the template, verify your `--body` includes every one of these sections (names must match exactly):

- [ ] `## Thinking Path` — blockquote style, 5-8 reasoning steps
- [ ] `## What Changed` — bullet list of concrete changes
- [ ] `## Verification` — how a reviewer confirms this works
- [ ] `## Risks` — what could go wrong
- [ ] `## Model Used` — provider, model ID, version, capabilities
- [ ] `## Checklist` — copied from the template, items checked off

If any section is missing or empty, do NOT submit the PR. Go back and fill it in.

### Step 3 — Create the PR

Only after completing Steps 1 and 2, run `gh pr create`. Use the template contents as the structure for `--body` — do not write a freeform summary.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Server won't start | Run `npx paperclipai doctor --repair` to diagnose and auto-fix |
| Forgetting to source worktree env | Run `eval "$(npx paperclipai worktree env)"` after cd-ing into the worktree |
| Stale dependencies after pull | Run `pnpm install && pnpm build` after pulling |
| Schema out of date after pull | Run `pnpm db:generate && pnpm db:migrate` |
| Reseeding while target DB is running | Stop the target server first, or use `--allow-live-target` |
| Cleaning up with unmerged commits | Merge or push first, or use `--force` if intentionally discarding |
| Running agents against wrong instance | Verify `PAPERCLIP_API_URL` points to the correct port |
