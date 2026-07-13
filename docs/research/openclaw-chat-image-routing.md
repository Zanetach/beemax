# OpenClaw chat image routing with a text-only main model

Research date: 2026-07-13. Sources are OpenClaw and Z.AI first-party documentation.

## Inbound path

OpenClaw channel plugins collect inbound `MediaPaths`, `MediaUrls`, and `MediaTypes`. The shared media-understanding pass runs before the reply pipeline. If the main reply model supports images, OpenClaw skips the summary block and sends the original image to it. With a text-only Gateway/WebChat model, the attachment is retained as a `media://inbound/*` reference and a configured image model can summarize it for the text-model conversation. It supports ordered model/CLI fallback, size limits, timeouts, and bounded summaries. [Media understanding](https://docs.openclaw.ai/nodes/media-understanding)

This path applies to chat channels such as Telegram and the official Feishu plugin; channel support still depends on that plugin correctly downloading the attachment. [Chat channels](https://docs.openclaw.ai/channels)

## GLM composition

The official OpenClaw Z.AI catalog includes both `zai/glm-5.2` and `zai/glm-5v-turbo`. GLM-5.2 is appropriate as the main reasoning model; GLM-5V-Turbo is the image model. [Z.AI provider](https://docs.openclaw.ai/providers/glm)

```bash
openclaw onboard --auth-choice zai-api-key
openclaw models set zai/glm-5.2
openclaw models set-image zai/glm-5v-turbo
```

`set-image` writes `agents.defaults.imageModel.primary`. Image fallbacks can be managed with `openclaw models image-fallbacks ...`. [Models CLI](https://docs.openclaw.ai/cli/models)

If a Coding Plan credential/endpoint does not expose GLM-5V-Turbo, use a separate image-capable provider instead of assuming the text-plan endpoint supports it.

## Verification

Before testing a channel, probe the same image model directly:

```bash
openclaw infer image describe \
  --file ./test.png \
  --model zai/glm-5v-turbo \
  --prompt "Extract visible text and describe the image" \
  --json
```

The selected model must be declared image-capable. The command reports provider/model attempts and is a narrower diagnostic than a complete Agent turn. [Inference CLI](https://docs.openclaw.ai/cli/infer)

Then send the same image through the real chat and inspect channel/Gateway logs. This separates provider/model failures from channel attachment-ingestion failures.

## OCR boundary

The image model is suitable for screenshot and general image understanding, but a short media summary is not an auditable OCR record. Exact document ingestion, tables, bounding boxes, and confidence should use a dedicated OCR/document capability such as PaddleOCR MCP or GLM-OCR, with the original media digest retained as evidence.
