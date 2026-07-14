# Docker Execution Sandbox Release Contract

## Problem Statement

BeeMax exposes one `ExecutionPort`, but the current configuration makes `local` look like a peer Sandbox backend even though it executes with the BeeMax host user's authority. Docker already applies several constraints, but cancellation cleanup, privilege hardening, executable evidence, and the exact capability boundary are not yet a production release contract. Operators therefore cannot distinguish “Profile isolation”, “Tool approval”, and “command isolation”, or prove that an interrupted Docker Tool did not leave a container running.

## Solution

Declare Docker as the first production Execution Sandbox and retain local execution as an explicitly trusted Host Execution Adapter. All built-in `bash`, `read`, and `write` calls continue through the existing `ExecutionPort` seam. When Sandbox mode is `all`, Pi host filesystem tools that cannot cross that seam remain unavailable. Each Docker execution is one-shot, Profile-labelled, network-disabled, read-only at the container root, capability-dropped, no-new-privileges, resource-bounded, and forcibly removed after timeout or cancellation. Workspace access remains explicit as none, read-only, or read-write.

## User Stories

1. As an operator, I want `doctor` to distinguish a Docker Execution Sandbox from trusted host execution, so that I do not mistake a Profile for a security boundary.
2. As an operator, I want a missing Docker daemon to fail diagnostics before production traffic, so that Sandbox configuration cannot silently fall back to host execution.
3. As an administrator, I want Sandbox mode `all` to route every built-in command/file Capability through Docker, so that Pi cannot bypass the selected Adapter.
4. As an administrator, I want network disabled by default, so that untrusted commands cannot make arbitrary outbound requests.
5. As an administrator, I want a read-only root filesystem, dropped Linux capabilities, and no-new-privileges, so that a command has minimal container authority.
6. As an administrator, I want CPU, memory, PID, temporary-storage, and output limits, so that one Tool cannot consume unbounded host resources.
7. As a Profile owner, I want workspace access to default to none and support explicit read-only or read-write mounts, so that file authority is visible and least-privileged.
8. As a Profile owner, I want file paths confined to the configured workspace, so that relative traversal or external host paths cannot escape the mount.
9. As a user, I want `/stop`, cancellation, and timeout to remove the active one-shot container, so that interrupted work does not continue invisibly.
10. As an auditor, I want Sandbox containers labelled with their Profile and purpose without message content, so that orphan inspection is possible without leaking prompts.
11. As a developer, I want trusted local execution to remain available when Sandbox mode is off, so that local workflows do not require Docker.
12. As a security reviewer, I want documentation to state that MCP, Browser, Channel, and tenant isolation are outside this Sandbox, so that the claim is not broader than the evidence.

## Implementation Decisions

- Keep `ExecutionPort` as the only execution seam; do not add another Agent Loop, command router, or policy authority.
- Keep exactly two Adapters: Docker Execution Sandbox and Host Execution Adapter. `mode=off` explicitly selects trusted host execution; `mode=all` with `backend=docker` selects Docker and never falls back.
- Bind cancellation to the process invocation and assign every Docker run a random, content-free name plus Profile labels. Cleanup is idempotent and force-removes the named container after abnormal settlement.
- Docker receives no host environment or credential mounts from this module. Network stays `none`; the container root stays read-only; the only writable root path is bounded `/tmp`.
- Workspace mount policy is `none`, `ro`, or `rw`. `writeFile` fails before launching Docker unless policy is `rw`.
- Default image is pinned to the declared Node 22 release tag. Enterprises may configure another image, but that choice is operator authority and must pass the same runtime gate.
- Tool approval, Enterprise Policy, Effect Authority, and Execution Grant remain upstream governance. Sandbox constraints are defense in depth and never grant an action.
- Update P2/TBD-4 to record Docker as the first production Sandbox and local execution as trusted compatibility mode.

## Testing Decisions

- Test `ExecutionPort` behavior rather than Docker argument assembly wherever possible.
- Unit tests prove backend selection, workspace confinement, read-only write rejection, cancellation propagation, and host-tool suppression.
- A Linux-only release evaluator uses the real Docker daemon to prove no network, read-only root, dropped capabilities, no-new-privileges, cgroup limits, workspace none/ro/rw behavior, bounded output, timeout cleanup, and Profile labels.
- CI and tag release pin Ubuntu 24.04 and upload a content-free JSON Sandbox evidence artifact. Non-Linux or missing-Docker execution fails closed rather than reporting a pass.
- The complete release suite remains responsible for Tool Governance, Effect idempotency, Profile ownership, and hostile-scope isolation; the Sandbox evaluator does not duplicate those authorities.

## Out of Scope

- Sandboxing MCP, Browser, Channel adapters, model providers, or the BeeMax Gateway process.
- Claiming Docker containers alone form a hostile multi-tenant boundary.
- Kubernetes, microVM, remote execution, persistent development containers, or per-Session container reuse.
- Automatic image building, image vulnerability remediation, or enterprise image allowlist policy.
- Enabling high-risk autonomous mutation merely because a Sandbox exists.

## Further Notes

One-shot containers favor isolation and cleanup over warm-start performance. Persistent Profile or Session containers can be evaluated later only if they preserve the same Effect, cancellation, workspace, and tenant semantics.
