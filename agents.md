# TypeScript Engineering Standards

This document defines stable coding standards for high-quality TypeScript code.
It is intentionally project-agnostic: use these rules across modules without tying them to changing product decisions.

## 1) Core principles
- Prefer correctness and readability over cleverness.
- Keep behavior deterministic where possible.
- Design for explicit contracts and predictable failure modes.
- Optimize after measuring, not by intuition.

## 2) Type safety baseline
- Use `strict` TypeScript configuration.
- Avoid `any`; if unavoidable, isolate it at IO boundaries and document why.
- Prefer `unknown` over `any` when parsing untrusted data.
- Model domain data with explicit interfaces/types, not ad-hoc object literals.
- Use discriminated unions for variant states.
- Use `readonly` for immutable structures and function inputs when possible.
- Avoid non-null assertions (`!`) unless invariants are proven locally.

## 3) API and module design
- Keep modules single-purpose and cohesive.
- Export minimal public surface; keep internals private by default.
- Prefer pure functions for transforms and calculations.
- Separate layers clearly:
- IO/adapters (fetch, DB, filesystem)
- Domain logic (rules, transforms)
- Presentation/render glue
- Do not let UI or transport concerns leak into domain types.

## 4) Function design rules
- Keep functions small and intention-revealing.
- Prefer explicit inputs/outputs over hidden mutable state.
- Limit parameter count; use typed parameter objects when needed.
- Return structured results for recoverable failures (result objects) instead of throwing broadly.
- Throw only for truly exceptional, unrecoverable states.

## 5) Error handling and resilience
- Classify errors: validation, network/IO, timeout, internal invariant.
- Preserve causal context when rethrowing or mapping errors.
- Never swallow errors silently; log with actionable context.
- Add retry/backoff only where idempotency is guaranteed.
- Set explicit timeouts for external operations.

## 6) Async and concurrency
- Use `async/await` consistently.
- Bound concurrency for expensive or remote operations.
- Support cancellation where tasks can become obsolete.
- Avoid race conditions by modeling ownership and lifecycle explicitly.
- Ensure cleanup paths run on cancellation and failures.

## 7) State and data flow
- Prefer immutable updates for shared state.
- Centralize state transitions in dedicated modules/services.
- Make side effects explicit and easy to trace.
- Version persisted schemas and validate on read.
- Keep serialization/deserialization logic explicit and tested.

## 8) Performance standards
- Measure before optimizing; add lightweight instrumentation in hot paths.
- Avoid per-frame allocations in tight loops.
- Reuse objects/buffers in performance-critical code.
- Use pooling/instancing strategies when repeated structures are rendered or processed.
- Dispose/release resources explicitly when lifecycle ends.

## 9) Testing standards
- Unit test pure logic and edge cases first.
- Add integration tests for boundary seams between modules/layers.
- Add regression tests for every production bug.
- Prefer deterministic tests (fixed seeds, controlled clocks).
- Avoid brittle snapshot-heavy tests for dynamic structures.

## 10) Code style and naming
- Follow formatter and linter rules automatically in CI.
- Use descriptive names; avoid abbreviations without domain meaning.
- Types/interfaces: nouns. Functions: verbs. Booleans: `is/has/can` prefix.
- Keep comments for intent and invariants, not for obvious code narration.
- Remove dead code quickly; avoid commented-out code blocks.

## 11) Observability and diagnostics
- Add structured logs at module boundaries and failure points.
- Include stable identifiers in logs for traceability.
- Keep debug instrumentation behind flags/toggles.
- Track latency/error-rate counters for critical flows.

## 12) Review checklist (PR gate)
- Types are strict and meaningful; no accidental `any`.
- Public API is minimal and documented by types.
- Error paths are explicit and tested.
- Performance implications are noted for changed hot paths.
- Resource lifecycle is correct (init, reuse, cleanup).
- Tests cover success, failure, and edge cases.
- No hidden coupling across layers.

## 13) Anti-patterns to avoid
- God modules that mix IO, business rules, and presentation.
- Boolean parameter traps (`doThing(true, false, true)`).
- Silent fallback behavior that hides data quality issues.
- Shared mutable globals without ownership.
- Premature micro-optimizations without profiling evidence.

## 14) Continuous improvement policy
- If a repeated code smell appears, extract a reusable utility/pattern.
- If a bug category repeats, add a lint rule/test template/checklist item.
- Keep standards evolving via small, explicit updates with rationale.

## 15) Three.js optimization and best practices
- Establish explicit frame budgets (CPU frame time, GPU frame time, draw calls, triangles) and track them continuously.
- Prefer fewer draw calls over complex scene graphs; batch static geometry and use instancing for repeated meshes.
- Use LOD and distance-based culling by default for non-critical detail.
- Keep materials minimal and shared; avoid unnecessary material variants that fragment batching.
- Reuse geometries, textures, and materials whenever possible; avoid runtime churn.
- Dispose GPU resources explicitly (`geometry.dispose`, `material.dispose`, `texture.dispose`) when objects are unloaded.
- Avoid per-frame object allocation in render/update loops; reuse vectors, matrices, and temporary buffers.
- Limit dynamic shadows; use baked/lightweight lighting where quality permits.
- Keep texture strategy disciplined and consistent across assets.
- Use compressed textures when available.
- Use mipmaps and power-of-two dimensions when practical.
- Use atlases to reduce material switches where it makes sense.
- Move heavy mesh generation and preprocessing off the main thread (workers) when feasible.
- Keep collision and gameplay meshes simpler than render meshes when full fidelity is unnecessary.
- Favor deterministic generation for streamed content to avoid visual popping across reloads.
- Validate frustum culling settings per object type; disable only when correctness requires it.
- Profile with real devices and production builds, not only desktop dev mode.
- Add runtime debug panels/toggles for render cost attribution (draw calls, triangles, resource counts, build times).
