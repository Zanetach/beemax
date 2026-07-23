---
name: historical-market-research
description: Research a historical market trend with structured time-series evidence, independent source checks, explicit instrument definitions, and a decision-ready report. Use for 黄金走势, 历史行情, 价格趋势, historical market research, or gold trend reports.
triggers: ["调研", "黄金走势", "历史行情", "价格趋势", "historical market research", "gold trend"]
---

# Historical market research

Confirm the instrument, quote currency, observation window, timezone, and intended decision from the request. For low-risk research, do not block on a detail that can be handled with a visible, reversible assumption.

When the user asks for a historical trend without a period, use the most recent 30 calendar days ending on the latest available observation. State that assumption briefly and continue. If the requested period is longer than one Provider call permits, split it into bounded chronological windows while preserving one instrument, unit, timezone, and trading-day definition.

Prefer a structured domain Tool such as `market_series` when it exactly matches the requested instrument and period. Retain source timestamps, observation dates, units, and Source Receipts. Cross-check material direction or endpoints with at least one independent source before drawing conclusions.

If a read-only source or Provider fails, inspect its structured failure, retain successful evidence, and do not repeat the identical failed call. Discover an equivalent healthy read-only capability and continue when the evidence standard can still be met. Never weaken the requested instrument or evidence standard merely to finish.

For spot XAU/USD, never silently substitute futures, ETFs, local-currency quotes, or derived reference values. Label every proxy, transformation, incomplete period, and market-calendar limitation.

Deliver the answer first, followed by the period and instrument definition, key observations, evidence-backed drivers, risks and limitations, and linked sources. Separate sourced facts from inference and do not present the result as investment advice. If the user requests a formal file or management-ready document, complete this research Skill, then progressively discover an applicable report Skill instead of loading unrelated instructions up front.
