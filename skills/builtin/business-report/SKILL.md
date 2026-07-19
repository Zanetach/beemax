---
name: business-report
description: Produce structured Chinese business reports, proposals, summaries, operating reviews, market analyses, and decision memos. Use when the user asks for 报告, 方案, 汇报, 复盘, 分析, 调研总结, or management-ready documents.
triggers: ["报告", "方案", "汇报", "复盘", "分析", "调研总结", "business report", "market analysis"]
---

# Business report

Start with the decision the reader must make. Separate verified facts, user-provided facts, assumptions, analysis, and recommendations.

Use this default structure unless the user supplies one: executive summary; context and objective; evidence; analysis; options and trade-offs; recommendation; action plan; risks and open questions.

Lead with conclusions, use tables only for real comparisons, and make every metric traceable. Do not invent sources, performance, customers, or financial figures.

Before writing an Artifact, compile one acceptance matrix from the Work Contract. Include every output path, visible literal, exact raw-source literal, formatted equivalent, external-source count, evidence check, and required verification dimension. Reuse an existing completed research Artifact when the Contract says to do so; do not restart broad research.

For HTML, bind every explicitly required raw value to its formatted visible equivalent in one element: put exactly one corresponding inert audit attribute on that element and render the formatted value inside it. If the Work Contract names an exact attribute such as `data-source-value`, use that exact attribute; otherwise default to one `data-source-value` attribute per value element. Do not invent alternate attribute names or place several raw values on a shared parent. Write the complete Artifact once, then run one consolidated HTML `artifact_inspect` for existence, integrity, semantic, and render with all visible assertions in `requiredText`, source-only assertions in `requiredSourceText`, every raw/formatted mapping in `requiredSourceVisiblePairs`, and the exact URL bounds. Never put a source-only raw literal in `requiredText`, and do not request consistency on the source HTML merely because a derivative will be checked later. If inspection fails, use the returned missing-assertion list and make one consolidated correction instead of probing assertions one at a time.

Only after the source Artifact passes, render the requested derivative once and inspect the derivative once against the explicit source Artifact. For HTML-to-PDF consistency, inspect the PDF output with `consistentWithPath` pointing to the HTML and `consistentWithMediaType` set to `text/html`; never use the PDF as the consistency source. The consistency receipt must preserve source text and the exact external citation-link set. Fetch independent URLs in parallel when possible. Finish the Skill lifecycle only after every required Artifact and evidence receipt exists.
