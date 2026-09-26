import { randomUUID } from "node:crypto";
import { CODEX_CHATGPT_IMAGE_MODEL } from "@marinara-engine/shared";
import { logDebugOverride } from "../../lib/logger.js";
import { safeFetch } from "../../utils/security.js";
import {
  OPENAI_CHATGPT_CODEX_BASE_URL,
  buildOpenAIChatGPTHeaders,
  getOpenAIChatGPTAuth,
  type OpenAIChatGPTAuth,
} from "../llm/openai-chatgpt-auth.js";
import type { ImageGenRequest, ImageGenResult } from "./image-generation.js";

// Codex's built-in image tool uses this standalone Images API route for ChatGPT OAuth sessions.
const GENERATIONS_URL = `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/generations`;
const EDITS_URL = `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/edits`;
const MAX_EDIT_IMAGES = 5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ImageDependencies = {
  getAuth: () => Promise<OpenAIChatGPTAuth>;
  fetch: typeof safeFetch;
};

function imageAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (/No Codex ChatGPT login|ENOENT|not ChatGPT OAuth|does not contain an access token/i.test(message)) {
    return new Error("ChatGPT/Codex image generation needs a ChatGPT login. Run `codex login` on the Marinara host.");
  }
  if (/refresh|stale|expir/i.test(message)) {
    return new Error("ChatGPT/Codex login has expired or could not be refreshed. Run `codex login` again.");
  }
  return new Error("ChatGPT/Codex login could not be read. Check the local Codex login and try again.");
}

export async function getCodexChatGPTImageAuth(): Promise<OpenAIChatGPTAuth> {
  try {
    return await getOpenAIChatGPTAuth();
  } catch (error) {
    throw imageAuthError(error);
  }
}

function imageHttpError(status: number, payload: unknown): Error {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const nested = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
  const code = typeof nested?.code === "string" ? nested.code : typeof record?.code === "string" ? record.code : "";
  if (status === 429 || /quota|usage.limit|rate.limit/i.test(code)) {
    return new Error("ChatGPT/Codex image generation usage limit reached. Wait for the limit to reset and try again.");
  }
  if (status === 401) return new Error("ChatGPT/Codex login was rejected. Run `codex login` again.");
  if (status === 403) return new Error("This ChatGPT account is not allowed to generate images through Codex (403).");
  return new Error(`ChatGPT/Codex image generation failed (HTTP ${status}). Try again later.`);
}

function referenceImageDataUrl(reference: string): string {
  // The shared image helper defaults unknown bytes to PNG; this endpoint must reject malformed references.
  const value = reference.trim();
  const dataUrl = value.match(/^data:(image\/(?:png|jpe?g|webp|gif|avif|bmp));base64,([\s\S]*)$/iu);
  if (value.startsWith("data:") && !dataUrl) {
    throw new Error("ChatGPT/Codex reference image has an invalid data URL.");
  }
  const compact = (dataUrl?.[2] ?? value).replace(/\s+/gu, "");
  const unpadded = compact.replace(/=+$/u, "");
  if (
    !unpadded ||
    /[^A-Za-z0-9+/]/u.test(unpadded) ||
    unpadded.length % 4 === 1 ||
    compact.length - unpadded.length > 2
  ) {
    throw new Error("ChatGPT/Codex reference image is not valid base64 image data.");
  }
  const base64 = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const bytes = Buffer.from(base64.slice(0, 64), "base64");
  let mimeType: string | null = null;
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) mimeType = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mimeType = "image/jpeg";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    mimeType = "image/webp";
  else if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) mimeType = "image/gif";
  else if (bytes.toString("ascii", 0, 2) === "BM") mimeType = "image/bmp";
  else if (bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))) {
    mimeType = "image/avif";
  }
  if (!mimeType) throw new Error("ChatGPT/Codex reference image is not a recognized image.");
  const declaredMimeType = dataUrl?.[1]?.toLowerCase().replace("image/jpg", "image/jpeg");
  if (declaredMimeType && declaredMimeType !== mimeType) {
    throw new Error("ChatGPT/Codex reference image data URL does not match its image format.");
  }
  return `data:${mimeType};base64,${base64}`;
}

function editReferences(request: ImageGenRequest): Array<{ image_url: string }> {
  const references = [request.referenceImage, ...(request.referenceImages ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  const imageUrls = [...new Set(references.map(referenceImageDataUrl))];
  if (imageUrls.length > MAX_EDIT_IMAGES) {
    throw new Error(
      `ChatGPT/Codex image editing supports up to ${MAX_EDIT_IMAGES} reference images, but ${imageUrls.length} were provided.`,
    );
  }
  return imageUrls.map((image_url) => ({ image_url }));
}

function codexImageSize(request: ImageGenRequest): string {
  const { width, height } = request;
  return width !== undefined &&
    Number.isSafeInteger(width) &&
    width > 0 &&
    height !== undefined &&
    Number.isSafeInteger(height) &&
    height > 0
    ? `${width}x${height}`
    : "auto";
}

/** One PNG result. The connection keeps Codex's fixed image model. */
export async function generateCodexChatGPTImage(
  request: ImageGenRequest,
  dependencies: ImageDependencies = { getAuth: getCodexChatGPTImageAuth, fetch: safeFetch },
): Promise<ImageGenResult> {
  const images = editReferences(request);

  const auth = await dependencies.getAuth();
  const prompt = request.negativePrompt?.trim()
    ? `${request.prompt.trim()}\n\nDo not include: ${request.negativePrompt.trim()}.`
    : request.prompt.trim();
  logDebugOverride(request.debugMode === true, "[debug/image] ChatGPT/Codex image prompt:\n%s", prompt);

  let response: Response;
  try {
    response = await dependencies.fetch(images.length > 0 ? EDITS_URL : GENERATIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
        ...buildOpenAIChatGPTHeaders(auth),
        "x-codex-image-turn-id": randomUUID(),
      },
      body: JSON.stringify({
        ...(images.length > 0 ? { images } : {}),
        model: CODEX_CHATGPT_IMAGE_MODEL,
        prompt,
        background: request.transparentBackground === true ? "transparent" : "opaque",
        quality: "auto",
        size: codexImageSize(request),
      }),
      signal: request.signal,
      policy: {
        allowLocal: false,
        allowLoopback: false,
        allowedProtocols: ["https:"],
        maxRedirects: 0,
        flagName: "CODEX_CHATGPT_IMAGE",
      },
      agentOptions: { headersTimeout: 0, bodyTimeout: 0 },
      maxResponseBytes: 48 * 1024 * 1024,
      decodeCompressedResponse: true,
    });
  } catch {
    if (request.signal?.aborted) throw new Error("ChatGPT/Codex image generation was cancelled or timed out.");
    throw new Error("Could not reach ChatGPT/Codex image generation. Check the network and try again.");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw imageHttpError(response.status, payload);
  }

  const payload = (await response.json().catch(() => null)) as { data?: Array<{ b64_json?: unknown }> } | null;
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("ChatGPT/Codex returned an invalid image response.");
  }
  const base64 = payload.data[0]?.b64_json;
  if (typeof base64 !== "string" || !base64.trim()) {
    throw new Error("ChatGPT/Codex returned no image data.");
  }
  const image = Buffer.from(base64, "base64");
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("ChatGPT/Codex returned invalid PNG image data.");
  }
  return { base64, mimeType: "image/png", ext: "png" };
}
