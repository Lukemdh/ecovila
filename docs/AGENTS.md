# AGENTS.md — Standing Instructions for AI Agents

This file governs how any AI agent works in the EcoVila repository. It is short on
purpose. Read it fully every session, then read `docs/plan.md` fully, before doing
anything else.

All audit/cleanup documentation for this project lives in the `docs/` folder
(`docs/AGENTS.md`, `docs/plan.md`, `docs/README.md`, etc.). When this file says
"README.md" or "plan.md" it means the copy inside `docs/`.

---

## READ FIRST — every session, in this order

1. Read this entire file (`docs/AGENTS.md`).
2. Read `docs/plan.md` in full.
3. In `docs/plan.md`, find the **first step whose Status is not DONE**. That is the
   ONLY step you work on this session.
4. Read that step's **Required reading** list (docs + source files) before touching
   any code.
5. Do the step. Run its **Verification**. The step is not done until verification
   passes.
6. Apply the **Definition of Done** below (update every affected doc).
7. Commit (docs + code together). Mark the step DONE in `docs/plan.md`, update the
   progress tracker, append a Session Log entry. Then stop.

Do not skip ahead. Do not batch multiple steps. Each step is sized for one focused
session and assumes you remember nothing from previous sessions.

---

## The per-session loop command the human will use

> "Read `docs/AGENTS.md` and `docs/plan.md`, then do the next step."

That is the entire workflow. Everything you need to execute the next step must be
discoverable from `docs/AGENTS.md` + `docs/plan.md` + that step's Required reading.

---

## Definition of Done (the doc-update law) — NON-NEGOTIABLE

A step is **NOT complete** until you have reviewed and, where affected, UPDATED every
one of these files:

- `docs/README.md`
- `docs/project-overview.md`
- `docs/project-structure.md`
- `docs/project-history.md`   (append what changed this session)
- `docs/production-readiness-audit.md` (update when an audit/readiness scan changes)
- `docs/security.md`          (update if security posture changed)
- `docs/bugs.md`              (update status of any bug touched)
- `docs/decisions.md`         (log any decision made)
- `docs/conventions.md`       (update if a pattern/standard changed)
- `docs/plan.md`              (set step Status, update progress tracker, append session log)

Agents tend to skip this. Treat it as mandatory. If a doc was genuinely unaffected,
explicitly note in the session log that you checked it and it needed no change. Then
commit the docs together with the code change for that step.

These docs are interrelated and MUST be kept mutually consistent. If you change a
fact (a path, a command, an env var, a behavior) in one doc, search the others for
the same fact and update them too.

---

## Document map (one line each, and when to update)

- `docs/AGENTS.md` — this file; standing agent rules. Update only if the workflow itself changes.
- `docs/plan.md` — the cleanup plan and single source of truth for what to do next. Update every session.
- `docs/README.md` — how to install/run/test/deploy. Update when commands, env, or tooling change.
- `docs/project-overview.md` — what the product is, features, domain, architecture. Update when product/architecture changes.
- `docs/project-structure.md` — the file/dir map and data flow. Update when files move, are added, or removed.
- `docs/project-history.md` — running historical log. Append every session.
- `docs/production-readiness-audit.md` — latest pre-production scan. Update when a
  broad audit or production-readiness check is performed.
- `docs/security.md` — running security posture/findings log. Update when posture changes.
- `docs/bugs.md` — running bug log. Update the status of any bug you touch.
- `docs/decisions.md` — architectural decision log. Append when you make a decision.
- `docs/conventions.md` — the coding standards the repo actually follows. Update if a pattern changes.

---

## Safety rules

- **Commit after every step.** One step = one (or few) coherent commits. Never leave a
  step half-done across sessions without recording state in the session log.
- **Never force-push.** Never `git reset --hard`, `git clean -f`, or delete branches
  without explicit human approval.
- **Never delete ambiguous files without flagging.** If you are not certain a file is
  dead, list it in `docs/bugs.md` / the relevant step and ask, rather than deleting.
- **Keep every change reversible.** Prefer small, isolated commits. No sweeping
  rewrites in a single step.
- **Run verification before marking DONE.** A step that fails its verification is not
  done — keep it IN PROGRESS and record the blocker.
- **No secrets in the repo.** Never commit real API keys, service-role keys, or
  `.env` contents. The Supabase *anon* key is public by design and may stay in
  `js/supabase-config.js`.
- **Do not skip hooks** (`--no-verify`) or bypass checks to make a step "pass."
- **This is a static-hosted site** (tophost.md, no Node server). Do not introduce a
  runtime build step or server-side Node dependency for the public site without an
  explicit decision logged in `docs/decisions.md`.
