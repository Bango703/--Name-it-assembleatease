# AAE — Deep Execution, Persistent Knowledge & Context Efficiency Protocol

Status: adopted by the owner, 2026-11-13. Applies to every change in this repository, by any agent or person. Where it overlaps CLAUDE.md, CLAUDE.md governs; this protocol adds to it.

How it maps onto this repository:
- "docs/architecture/" is `docs/platform/` (numbered reference documents, already maintained).
- The knowledge map is `docs/knowledge-index.md`. Start there.
- The single prioritized backlog stays `business-artifacts/backlog.md` (CLAUDE.md, Backlog Discipline). `docs/work-in-progress.md` records only active work and its next action.
- `scripts/test-knowledge-index.mjs` fails the regression gate if the index points at a file that does not exist, or if current state or work in progress lose their verification dates.

## 1. Mandatory deep execution

Every user request must be treated as a potentially system-wide change.

Do not interpret requests narrowly when their implementation affects existing business workflows.

Before coding, determine:
- What the user explicitly requested.
- What must also change for the request to work end to end.
- Which existing components and services are affected.
- Which business invariants must remain true.
- Which edge cases, failure conditions, and recovery paths apply.
- What success looks like from the actual user's perspective.

Do not implement only the visible UI if the feature also requires database, API, authorization, state synchronization, notifications, or other backend behavior.

Do not add unrelated functionality merely to appear comprehensive.

## 2. Trace the complete dependency chain

For every change, examine the applicable paths through:

Customer → Booking → Pricing → Payment → Geographic Coverage → Easer Eligibility → Dispatch → Assignment → Notifications → Job Completion → Payout → Reporting.

Also inspect affected administrative controls, trust/safety workflows, permissions, and recovery mechanisms.

Mark each subsystem as AFFECTED, VERIFIED UNAFFECTED, or REQUIRES INVESTIGATION.

Every affected subsystem must have a corresponding implementation or verification task.

## 3. No premature completion

A task is complete only when:
- All acceptance criteria are satisfied.
- All required code changes are implemented.
- Existing business invariants are preserved.
- Necessary database migrations are verified.
- Related dashboards and APIs are consistent.
- Notifications and asynchronous processing are verified where applicable.
- Edge cases and failure recovery are covered.
- Required automated tests pass.
- Relevant documentation is updated.
- Any release approval requirements are satisfied.

Do not confuse successful code generation with working production functionality.

Never describe an unverified or partially completed implementation as fully complete.

## 4. Persistent project knowledge

The repository is the authoritative source of persistent project engineering knowledge. Maintain:
- AGENTS.md (with CLAUDE.md): stable operating instructions.
- docs/platform/: verified architecture and system relationships.
- docs/business-rules/: approved business policies and invariants.
- docs/decisions/: significant architectural decisions and rationale.
- docs/incidents/: confirmed defects, causes, and prevention measures.
- docs/current-state.md: verified current system capabilities and limitations.
- docs/work-in-progress.md: active work, blockers, and remaining tasks.
- docs/knowledge-index.md: concise map of relevant documentation.

At the start of each task, read the instructions, the knowledge index, and only the relevant additional documents.

Inspect the code when documentation is insufficient or might be stale.

## 5. Automatic documentation maintenance

At the end of every task, evaluate whether repository knowledge needs updating.

When verified behavior, architecture, business rules, APIs, state transitions, or operational workflows change:
1. Update the relevant documentation in the same code change.
2. Record significant design decisions.
3. Update affected tests and traceability references.
4. Record newly discovered dependencies.
5. Update the current-state summary.
6. Update the work-in-progress file if work remains.
7. Remove or correct contradictory outdated documentation.
8. Update the knowledge index if document locations change.

Do not repeatedly rewrite unchanged documentation.

Do not store guesses, unverified conclusions, generated secrets, customer personal data, or temporary debugging noise as permanent facts.

Documentation changes must accurately reflect the verified implementation.

## 6. Context and token efficiency

Minimize unnecessary token and context consumption without sacrificing correctness. Use progressive context loading:
1. Read the compact repository instructions.
2. Read the relevant architecture document.
3. Inspect only the affected implementation areas.
4. Expand to additional dependencies discovered during analysis.
5. Reuse verified findings from maintained project documentation.
6. Avoid repeatedly reading unchanged large documents when reliable summaries and references are sufficient.

Maintain concise summaries with links to detailed source files.

Do not repeatedly re-explain established architecture in every task response unless necessary.

Do not use context optimization as justification for skipping required inspection, tests, or business-rule verification.

## 7. Task continuity

For substantial tasks, maintain a durable work record (`docs/work-in-progress.md`) containing: objective, approved scope, current implementation state, files changed, tests completed and results, known risks, outstanding work, next action.

When work resumes, consult this record and verify that it still matches the codebase.

Do not claim completion of unfinished work.

Do not treat a previous AI summary as proof that code was implemented.

## 8. System-wide verification

After making changes:
- Verify the requested behavior.
- Verify affected upstream and downstream integrations.
- Verify negative paths and failure handling.
- Verify authorization and data consistency.
- Run relevant regression tests.
- Run all required CI checks.
- Confirm no existing protected behavior has been unintentionally changed.

Where a requirement cannot be verified, report it clearly rather than assuming success.

## 9. AI self-correction

When an implementation mistake or misunderstanding is discovered:
1. Investigate the root cause.
2. Correct the implementation.
3. Add an appropriate regression test.
4. Update the relevant project knowledge (`docs/incidents/`).
5. Identify similar vulnerable workflows.
6. Re-run affected verification checks.

Never rely solely on remembering the correction in conversation.

## 10. Completion gate

Before reporting completion, produce a verification matrix covering: user requirements, affected architecture, implementation evidence, business rules, integration behavior, edge cases, security and authorization, testing results, documentation synchronization, deployment readiness.

A required failed, blocked, or unverified check prevents an ALL GREEN result.

Do not fabricate evidence or bypass checks to satisfy this requirement.

## Final operating principle

Think system-wide. Implement completely. Verify independently. Preserve existing behavior. Update verified project knowledge. Minimize unnecessary context usage.

Every change must leave AssembleAtEase more reliable and better documented than before.
