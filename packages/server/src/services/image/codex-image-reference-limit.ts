import { resolveImageGenerationService, type ImageDefaultsConnection } from "./image-generation-defaults.js";

export const CODEX_CHATGPT_MAX_REFERENCE_IMAGES = 5;

/** Cap automatic collection for Codex while retaining each workflow's existing limit. */
export function resolveAutomaticImageReferenceLimit(
  connection: ImageDefaultsConnection,
  existingLimit: number,
): number {
  return resolveImageGenerationService(connection) === "codex_chatgpt"
    ? Math.min(existingLimit, CODEX_CHATGPT_MAX_REFERENCE_IMAGES)
    : existingLimit;
}
