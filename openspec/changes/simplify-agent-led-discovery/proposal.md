# Simplify discovery around agent fit review

## Problem

The deployed search used strict title, score, and opportunistic gates before an agent could judge fit. Its optional semantic score was disabled in production and was not a relevance decision. A 50-source run returned no ready application despite many observed listings.

## Change

Make bounded source retrieval, known-role filtering, and simple explicit preferences deterministic. Return unseen listing evidence to one agent for an explicit fit verdict. Verify official employer destinations only for relevant roles, then use the existing single application worker and final-submission safeguards. Preserve PR #23's final-button classification.

## Scope

Add an agent-review scan mode, a browser-candidate duplicate filter, a fit-verdict intake, and a posting-bound fit gate. Change the job-application skill and operator docs to use this as the primary workflow. Keep the legacy campaign path until active state and reporting can be migrated safely.
