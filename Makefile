# Eval harness entry points.
# export      — step 1: dump per-turn records (input prompt, tool calls, output).
# eval        — full pipeline: run baseline prompts through the real Agent,
#               deterministic tool checks + LLM judge, write a report.
#               Requires `npm run build` and a configured Profile with model keys.
# eval-offline— re-evaluate an existing export without running the Agent.

HARNESS := evals/harness
OUT ?= $(HARNESS)/out/session-records.jsonl
RECORDS ?= $(OUT)
PROFILE ?= $(shell cat $${BEEMAX_HOME:-$$HOME/.beemax}/active-profile 2>/dev/null || echo default)
# Set SESSIONS=<dir-or-file> to export from an explicit path instead of a Profile.
EXPORT_SOURCE := $(if $(SESSIONS),--sessions "$(SESSIONS)",--profile "$(PROFILE)")

.PHONY: export eval eval-offline ui test clean help

## export: write one JSONL record per turn (input prompt, tool calls, output) to $(OUT)
export:
	node $(HARNESS)/export-session-records.mjs $(EXPORT_SOURCE) --out "$(OUT)"

## eval: run baseline cases through profile $(PROFILE), compare tools + LLM-judge outputs, open the panel
eval:
	node $(HARNESS)/run-eval.mjs --profile "$(PROFILE)"; status=$$?; node $(HARNESS)/open-ui.mjs; exit $$status

## eval-offline: evaluate an existing export (RECORDS=<file>) against the baseline, open the panel
eval-offline:
	node $(HARNESS)/run-eval.mjs --records "$(RECORDS)"; status=$$?; node $(HARNESS)/open-ui.mjs; exit $$status

## ui: start the local eval control panel in the foreground and open the browser
ui:
	node $(HARNESS)/server.mjs --open

## test: run the eval-harness tests, then make sure the panel is up
test:
	node --test $(HARNESS)/*.test.mjs; status=$$?; node $(HARNESS)/open-ui.mjs; exit $$status

## clean: remove exported records and reports
clean:
	rm -rf $(HARNESS)/out

help:
	@grep -E '^## ' Makefile | sed 's/^## //'
