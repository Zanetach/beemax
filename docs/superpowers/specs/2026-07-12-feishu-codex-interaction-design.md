# Feishu Codex-Style Interaction Design

> Historical implementation spec. Its interaction behavior remains relevant, but module ownership was superseded by the Channel Runtime split: `Dispatcher` now drives the platform-neutral `InteractionPresenter`, while Feishu owns `CardSession`, `FlushController`, buffering, and rendering under `packages/channel-feishu/src/presentation/`.

## Goal

Make one continuously updated Feishu card feel like Codex: acknowledge immediately, show concise truthful progress during work, stream readable answer chunks, and finish with a clean final answer.

## Interaction contract

- The first card is sent immediately when a Turn begins and says `已收到 · 正在理解需求`.
- Waiting updates remain truthful and appear at bounded intervals; a silent model must never look frozen.
- Tool, planning, work, fallback, approval, queue, and terminal state changes bypass ordinary text throttling.
- Answer deltas are coalesced into readable chunks and card patches are rate-limited to at most 4 updates per second.
- Once answer content starts, progress remains in the collapsed execution panel and the main area becomes the answer.
- Completion, failure, and cancellation force the latest buffered answer and terminal state onto the card.
- Existing approval actions, payload limits, recovery, and one-card behavior remain compatible.

## Architecture

`FlushController` gains an urgent scheduling mode that respects a 250 ms Feishu patch floor while bypassing the normal 800 ms cadence. `Dispatcher` sends the initial status frame before model dispatch, marks semantic lifecycle changes urgent, and configures `AdaptiveTextBuffer` for a responsive 300 ms maximum wait. Rendering continues to use `CardSession` as the single source of card state.

## Acceptance criteria

1. A new Turn sends a visible status card before a slow runtime produces an event.
2. Semantic progress changes are rendered ahead of ordinary buffered text updates.
3. Tiny answer deltas become visible within 300 ms without exceeding four patches per second.
4. Terminal events immediately include all buffered answer text.
5. Existing Gateway and card tests remain green.
