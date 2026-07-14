# Session Ownership Migration

## Problem Statement

共享群 Conversation 上线前，BeeMax 的 Session transcript 可能按消息 Actor 建立。一个新共享 Conversation 因而可能对应多个旧 transcript。运行时 fallback 虽能读取历史，却无法安全决定哪个旧 transcript 应成为共享历史；自动任选或合并都会制造错误上下文、重复消息或披露风险，也让 fallback 永久存在。

## Solution

提供 Profile 管理员显式执行的 Session Ownership Migration。管理员指定目标 Channel Instance、群 Conversation、可选 Thread 和一个 legacy Actor；`plan` 展示 canonical Session 与精确候选文件，`apply` 仅在唯一、完整、未冲突时把所选 transcript 复制为 canonical Session，并迁移内容无关的 Session Catalog 选择。旧 transcript 永久保留，系统不自动合并或删除。`rollback` 只在 canonical transcript 和 Catalog 均未发生后续变化时撤销迁移。

## User Stories

1. As a Profile Administrator, I want to inspect legacy transcript candidates before migration, so that BeeMax never guesses which history belongs to a shared group Conversation.
2. As a Profile Administrator, I want to select one legacy Actor transcript explicitly, so that ambiguous histories are resolved by an accountable human choice.
3. As a group user, I want the selected history to resume under the canonical shared Conversation identity, so that later participants receive one continuous Session.
4. As a security administrator, I want unselected legacy transcripts preserved and never merged, so that unrelated histories cannot be silently disclosed.
5. As an operator, I want apply to fail when a canonical Session already exists or a candidate is ambiguous, so that existing work is never overwritten.
6. As an operator, I want a durable manifest with source and target digests, so that the migration is auditable and recoverable after a crash.
7. As an operator, I want rollback to refuse after any canonical transcript or migrated Catalog preference changes, so that newer user work is never erased.
8. As an operator, I want the migration to use the same Profile process lock as Gateway lifecycle operations, so that a live Profile cannot write Session state concurrently.
9. As an operator, I want large transcripts copied as a stream, so that migration memory remains bounded.
10. As a product owner, I want legacy files retained without an automatic expiry, so that retention is conservative until an explicit, separately governed cleanup policy exists.

## Implementation Decisions

- Session Ownership Migration is infrastructure identity migration, not customer business ontology.
- Only group/thread Conversations are eligible; DM identity is already peer-specific.
- The canonical Session ID is derived by the existing Core Session identity function. Eligible legacy IDs are derived by the existing legacy compatibility function.
- The selected source must be exactly one valid Pi JSONL Session whose header ID matches an eligible legacy ID.
- Apply streams a rewritten canonical header plus the untouched JSONL remainder into a no-clobber target file; it does not load the transcript into Node memory.
- Source transcripts remain in place indefinitely. No automatic merge, deletion, or retention timer is introduced.
- Session Catalog migration copies only content-free discovery metadata to the canonical owner and retains the legacy record.
- A versioned manifest records prepared/applied/rollback-prepared/rolled-back/aborted state, paths, identities, digests, and the bounded Catalog receipt.
- Rollback removes only the exact unchanged canonical target and exact unchanged canonical Catalog record created by the migration. Any later change fails closed.
- The Profile Gateway lock fences plan/apply/rollback. File publication uses temporary files, fsync, no-clobber linking, and a parent-directory fsync.
- Pi remains the transcript implementation; no second Session store or Agent Loop is created.

## Testing Decisions

- Test the Core public Session migration seam with valid migration, ambiguous candidates, existing canonical target, large streamed transcript, changed-target rollback refusal, and exact Catalog restoration.
- Test the CLI public seam for plan, required confirmation, apply, rollback, configured Channel Instance validation, Profile path confinement, and crash-state continuation.
- Reuse the Channel Instance migration tests as prior art for lock, manifest, no-clobber artifact, and rollback-state behavior.
- Keep tests behavioral: assertions observe CLI results, canonical transcript restoration, preserved legacy files, Catalog visibility, and refusal outcomes rather than private helper calls.

## Out of Scope

- Automatic merging of multiple Actor transcripts.
- Automatic deletion or expiry of legacy transcripts.
- DM Session migration.
- Cross-Profile transcript movement.
- Customer-defined retention/compliance policy generation.
- Changes to Pi execution, Memory, Task Ledger, or Enterprise Policy.

## Further Notes

The conservative retention decision closes the current migration safety gap without pretending to know each enterprise's compliance period. A future cleanup command may delete archived legacy files only under an explicit enterprise retention policy and separate audit trail.
