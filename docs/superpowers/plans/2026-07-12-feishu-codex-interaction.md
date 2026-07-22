# Feishu Codex-Style Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver responsive Codex-style progress and answer streaming in one Feishu card.

**Architecture:** Extend the existing flush boundary with urgent semantic updates, then configure Dispatcher to send an immediate initial frame and use faster readable text buffering. Keep CardSession and Feishu transport interfaces unchanged.

**Tech Stack:** TypeScript, Node.js test runner, Feishu CardKit v2.

## Global Constraints

- One continuously updated card per Turn.
- At most four card patches per second.
- Terminal state always contains the complete buffered answer.
- Preserve recovery, payload, and transport compatibility; do not add Tool approval actions or reply parsing.

---

### Task 1: Urgent but rate-safe card flushing

**Files:**
- Modify: `packages/gateway/src/card/flush.ts`
- Test: `packages/gateway/test/card-flush.test.mjs`

**Interfaces:**
- Produces: `FlushController.schedule(renderUpdate, terminal?, urgent?)`.

- [ ] Add a failing public test proving urgent work bypasses the normal cadence but respects a 250 ms patch floor.
- [ ] Run `npm run build --workspace @thruvera/gateway && node --test packages/gateway/test/card-flush.test.mjs` and confirm failure.
- [ ] Add bounded urgent scheduling to `FlushController`.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Immediate first frame and semantic progress

**Files:**
- Modify: `packages/gateway/src/core/dispatcher.ts`
- Test: `packages/gateway/test/subagents.test.mjs`

**Interfaces:**
- Consumes: `FlushController.schedule(renderUpdate, terminal?, urgent?)`.
- Produces: observable `PlatformAdapter.sendCard`/`updateCard` ordering.

- [ ] Add a failing Dispatcher test proving the status card is sent before a delayed runtime result.
- [ ] Add a failing assertion that tool lifecycle and terminal events use urgent rendering.
- [ ] Send and drain the initial status frame before dispatch, configure answer buffering with `maxWaitMs: 300`, and mark semantic events urgent.
- [ ] Run focused Gateway tests until green.

### Task 3: Verify and deploy

**Files:**
- Modify only files required by verified failures.

- [ ] Run `npm run build`, `npm test`, `npm run typecheck`, and `git diff --check`.
- [ ] Review the diff against the design and repository standards.
- [ ] Commit the implementation.
- [ ] Restart `e2e-feishu` and verify running status plus `Feishu gateway connected` in logs.
