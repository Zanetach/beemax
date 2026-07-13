# OCR tools and text-model image handling

Research date: 2026-07-13. Sources are first-party documentation or official model repositories.

## Conclusion

An Agent's reasoning model does not need native image input. Put image understanding behind a capability interface and route each input to a suitable implementation:

- plain screenshots and Chinese/English text: PaddleOCR `PP-OCRv5`;
- document layout, tables, formulas, reading order: PaddleOCR `PP-StructureV3`;
- searchable PDF production: OCRmyPDF/Tesseract;
- general visual understanding beyond text: a separate vision-language model;
- high-value complex documents where cloud processing is allowed: a managed Document AI provider.

PaddleOCR provides an official MCP server exposing `ocr`, `pp_structurev3`, and VLM-based parsing tools, with local and hosted inference modes. This is the lowest-friction fit for an MCP-capable Agent. [PaddleOCR MCP server](https://www.paddleocr.ai/latest/en/version3.x/integrations/mcp_server.html)

## Hermes Agent

Hermes exposes `vision_analyze`. If the main model accepts vision, it returns the image as a native multimodal result. If the main model is text-only, Hermes calls a separately configured auxiliary vision model and returns its description as text. Therefore a text-only main model can still analyze images. [Hermes built-in tools](https://hermes-agent.nousresearch.com/docs/reference/tools-reference/), [Hermes vision flow](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/vision.md)

This fallback is general visual analysis, not necessarily deterministic OCR. For document ingestion, Hermes can additionally connect an OCR MCP server.

## GLM-5.2

The official `zai-org/GLM-5.2` model repository classifies it as **Text Generation** and its examples use text messages. It should not be treated as an image-input/OCR model. [Official GLM-5.2 model card](https://huggingface.co/zai-org/GLM-5.2)

Z.AI lists vision and OCR as separate model families. `GLM-5V-Turbo` accepts image, video, text, and files; `GLM-OCR` specializes in document parsing and information extraction. [Z.AI model overview](https://docs.z.ai/guides/overview/overview), [GLM-5V-Turbo](https://docs.z.ai/guides/vlm/glm-5v-turbo)

Recommended composition: GLM-5.2 remains the main reasoning/tool-calling model, while Hermes routes `vision_analyze` to GLM-5V-Turbo or another auxiliary VLM and routes document OCR to GLM-OCR or PaddleOCR MCP.

## Local tools

### PaddleOCR

`PP-StructureV3` recognizes layout regions, text, tables, formulas, seals, charts, and reading order, and can emit JSON or Markdown. Modules can be enabled independently and the pipeline supports local deployment and fine-tuning. [PP-StructureV3 usage](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html)

### Tesseract and OCRmyPDF

Tesseract is a mature CLI OCR engine with selectable language data and text/TSV/hOCR/PDF outputs. It is suitable for lightweight, deterministic OCR, but it is not a document-understanding engine. [Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)

OCRmyPDF adds a searchable OCR text layer to PDFs and uses Tesseract language packs. Ubuntu supports installation through `apt install ocrmypdf`. [OCRmyPDF installation](https://ocrmypdf.readthedocs.io/en/latest/installation.html)

## Managed fallback

Azure Document Intelligence Layout extracts text, tables, selection marks, document structure, confidence and Markdown. [Azure Layout model](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0)

Google Enterprise Document OCR supports document text and handwriting in more than 200 languages and includes document quality analysis. [Google Document AI processor list](https://docs.cloud.google.com/document-ai/docs/processors-list)

## Agent contract

An OCR tool should return evidence rather than only one text blob:

```text
text, blocks, bounding boxes, page, language, confidence,
engine, model version, input digest, warnings, raw artifact reference
```

Low-confidence output should trigger another implementation or request verification. The reasoning model may interpret OCR evidence, but must not silently present uncertain OCR as verified source text.
