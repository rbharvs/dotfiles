---
name: code-review
description: Independently review committed or uncommitted changes across scope and intent, correctness, simplicity, maintainability, and security. Use focused experiments and traces to investigate claims and report evidence-backed findings.
---

# Code review

Consider all five review lanes. Scale the depth of investigation to the change's
scope, risk, and architectural significance. Verify the implementation's claims
independently and choose checks that answer specific review questions.

## Establish the target

1. Read the agreed scope, intent, non-goals, referenced artifacts, and repository
   instructions. Clarify requirements whose interpretation affects the review.
2. Identify the exact reviewed snapshot. For committed work, record the base and
   head commits. For uncommitted work, record the available base and capture the
   staged, unstaged, and relevant untracked contents.
3. Inspect the complete diff and read the changed files in context. Trace relevant
   callers, tests, contracts, migrations, data flows, and state transitions.
4. Assess the existing verification evidence and identify unresolved questions.

Keep the reviewed files untouched. Verify at the end that the target still matches
the recorded snapshot. If it changed, identify the affected conclusions and review
the new snapshot before applying those conclusions to it.

## Investigate

Turn observations into hypotheses. Investigate each candidate finding until it is
supported or ruled out, including checking existing handling that could explain the
behavior. Choose the smallest reproduction, experiment, or validated trace that
answers the question. Broader checks are useful when the question spans that surface.

Experiments are available in every lane. For significant behavior or architecture,
challenge the highest-risk invariant or design claim. Evidence can also come from a
concrete code, caller, or dependency trace when it resolves the uncertainty. Choose
experiments according to their value for the change; each lane can use different
methods and depth.

Run modifying experiments in a separate worktree or isolated directory that matches
the reviewed snapshot, including relevant uncommitted contents. Prototypes, mutations,
and exploratory changes are normal review techniques. Keep track of experiment-owned
files and clean them up when finished. Retain useful unfinished experiments and report
their locations.

Delegate independent investigations when separate contexts help test different
hypotheses. Reconcile their evidence against the same reviewed snapshot.

## Review lanes

### Scope and intent

Check that the change delivers the agreed outcomes, preserves stated invariants,
respects non-goals, and stays within the requested scope. When reviewing a fix,
evaluate the accepted outcome and the complexity introduced by the remedy.

Exercise representative workflows through the public interface. Compare observable
results with the requirements, including behavior intended to remain unchanged.
Trace each material addition back to the intended change. Findings should identify
the relevant requirement or boundary and demonstrate the mismatch.

### Correctness

Examine boundary cases, failure paths, callers, migrations, partial states,
concurrency, cancellation, retries, resource cleanup, and production performance.
Check the complete user workflow and whether its interface behaves as promised.

Reproduce suspected failures, probe awkward inputs and operation sequences, and
inspect runtime behavior. Introduce a targeted mutation when useful to determine
whether a test detects the failure it claims to cover. Support findings with a
reproduction, failing check, or validated trace through the affected path.

### Simplicity

Look for duplicated paths, excessive state models, speculative generality, and
abstractions whose concepts exceed the needs of the domain. Ground assumptions in
the agreed domain rules and preserve supported behavior and trust-boundary validation.

Prototype a simpler implementation or stronger invariant in isolation. Compare its
behavior, states, branches, and concepts with the reviewed design. A concrete
structural comparison can also establish the finding. Explain which complexity the
alternative removes and why its assumptions hold.

### Maintainability

Examine responsibilities, policy duplication, coupling, control flow, API contracts,
test design, and documentation. Identify realistic adjacent changes the code is
likely to need.

Try implementing one of those changes, restructuring a responsibility, replacing an
implementation behind an interface, or building a small consumer against the public
API. Observe how many modules need coordinated edits, which assumptions leak across
boundaries, and how easily tests can express the new behavior. A validated caller or
dependency trace can provide equivalent evidence for a focused question. Tie findings
to concrete change costs or failure points.

### Security

Trace trust boundaries, authentication, authorization, tenant isolation, secrets,
cryptography, dependencies, and resource limits. Follow untrusted input into shells,
queries, templates, deserializers, regular expressions, filesystems, browser output,
and server-side requests where relevant.

Probe boundary inputs, attempt unauthorized operations, or construct a focused attack
reproduction. Check validation and authorization along the full path. A finding should
identify who controls the input, what it reaches, the protection that fails, and the
resulting impact.

## Report

Report actionable issues introduced or materially worsened by the change, ordered
by severity. For each finding, include:

- Severity: P0 (critical), P1 (serious), P2 (normal), or P3 (minor).
- Review lane and file/line location.
- Triggering scenario, problem, and impact.
- Supporting experiment, reproduction, or validated trace.

Keep findings concise. Put unresolved questions and optional suggestions in separate
sections. Identify the reviewed snapshot, summarize coverage across the five lanes
and the experiments or traces used, and state remaining uncertainty.

When there are no actionable findings, say **"No actionable issues found"** and
summarize the review's coverage and limitations.
