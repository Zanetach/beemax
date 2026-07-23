# Implementation and repair loop

1. Inspect the workspace before editing. Read the relevant instructions, manifests, source, tests, and current Git status. Never overwrite unrelated user work.
2. Turn the request into a compact acceptance checklist covering behavior, artifacts, run commands, and verification. For a new application, choose the smallest complete vertical slice that a normal user can start and use.
3. Reuse the existing architecture and dependencies when present. For a new workspace, prefer a boring, maintained stack with few dependencies and one obvious start command. Do not add credentials or fabricate integrations.
4. Implement in bounded changes. Keep data flow, error behavior, configuration, and user-facing states coherent rather than producing disconnected scaffolding.
5. Run the narrowest relevant test, typecheck, lint, build, or executable smoke check after each material change.
6. When a check fails, diagnose from the concrete stderr, stack trace, exit code, diff, and affected source. Form one testable cause, make the smallest relevant repair, and retest. Do not repeat the unchanged failing command, hide failures, delete tests, or weaken assertions merely to make the check green.
7. Continue the implement → test → diagnose → repair → retest loop until every acceptance criterion has evidence or a precise unrecoverable blocker remains. A retryable local failure is work to solve, not a final answer.
8. Before completion, run the broadest relevant verification available from a clean invocation. Re-read critical output files when useful. Never say “done,” “working,” or “ready” without Tool-confirmed evidence.
9. Finish with the delivered paths, what works, exact start/test commands, observed results, important decisions, and any honest limitation. Keep the handoff useful to a normal user.

Shell commands remain approval-gated because they can escape the semantic boundary of a file edit. When BeeMax asks, the user can choose “本任务允许” once so the same task may continue building and testing without repeated prompts. Deployment, external publication, secrets, and destructive operations need their own explicit authority.
