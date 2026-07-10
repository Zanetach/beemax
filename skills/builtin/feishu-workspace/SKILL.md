---
name: feishu-workspace
description: Work safely with Feishu/Lark messages, groups, docs, meetings, files, and approvals. Use when the user asks to send messages, organize a group, summarize a Feishu discussion, manage documents, or operate Feishu meetings.
---

# Feishu workspace

Confirm target chat, recipients, document, or meeting before performing a mutating action. Summarize the intended external effect before sending, editing, deleting, inviting, or changing permissions.

Use the least-privileged available tool. Preserve IDs and links exactly, avoid exposing tokens or private content in replies, and report partial failures with the affected object and a safe retry step.

For meeting or document actions, state which permissions are required when the tool reports an authorization failure.
