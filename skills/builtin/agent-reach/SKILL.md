---
name: agent-reach
description: Retrieve current public-web evidence through Thruvera's native Web tools. Use when the user explicitly asks for live Web search, current public sources, public URL extraction, or public online-platform evidence.
triggers: ["联网搜索", "网络检索", "搜索公开网页", "当前公开网页", "实时公开来源", "提取网页正文", "打开公开链接", "live web search", "public web search", "current public sources", "extract public URL"]
---

# Agent Reach

This is Thruvera's native Web routing Skill named Agent Reach, not the external Agent Reach CLI.

Use this Skill only for internet retrieval. Hand sourced evidence to the appropriate report, analysis, or writing Skill for synthesis.

## Native retrieval flow

1. Use `web_search` for general current public-web discovery.
2. Use `exa_web_search` when the active capability route specifically selects Exa semantic discovery.
3. Use `web_extract` to read the most relevant public URLs before relying on their claims.
4. Preserve the current Turn's source receipts and distinguish sourced facts from inference.

Prefer primary and authoritative sources. For substantial research, use multiple relevant sources and stop when the requested claims have sufficient evidence.

## Runtime boundary

Use only Thruvera's active, Profile-scoped Tools and Providers. Never assume that a machine-global `agent-reach`, `mcporter`, platform CLI, browser extension, or login session exists. Do not replace the native flow with shell commands, `curl`, Jina Reader, or an unverified external executable.

If the search Tools have no healthy Provider, or `web_extract` cannot fetch the requested public URL, report the precise configuration or connectivity blocker. Do not substitute remembered facts for requested current evidence, invent URLs, or describe a failed historical Provider attempt as the current state.

## Login-backed platforms

Twitter/X, Reddit, XiaoHongShu, Facebook, Instagram, LinkedIn, and other login-backed channels require a customer-configured Profile adapter and customer-owned credentials or interactive login. Use such a channel only after the customer explicitly configures it for the current Profile and Thruvera reports it healthy.

Never request, copy, print, or expose raw cookies, session tokens, passwords, or browser credential stores. A configured login-backed channel does not authorize posting, commenting, liking, following, purchasing, or any other external mutation unless the user explicitly requests that action.
