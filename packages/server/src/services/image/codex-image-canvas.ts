type CodexCanvasRequest = {
  width?: number;
  height?: number;
  skipCodexCanvasHint?: boolean;
};

export function resolveCodexImageDimensions(
  request: CodexCanvasRequest,
): { width: number; height: number } | undefined {
  const { width, height } = request;
  if (
    width === undefined ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    height === undefined ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return undefined;
  }
  return { width, height };
}

/** This exact addition is used by both prompt review and the Codex request. */
export function resolveCodexImageCanvasHint(request: CodexCanvasRequest, hasReferences: boolean): string | undefined {
  const dimensions = resolveCodexImageDimensions(request);
  if (!dimensions || request.skipCodexCanvasHint) return undefined;

  const { width, height } = dimensions;
  let divisor = width;
  let remainder = height;
  while (remainder !== 0) [divisor, remainder] = [remainder, divisor % remainder];
  const orientation = width === height ? "square" : width < height ? "portrait" : "landscape";
  return [
    ...(hasReferences
      ? ["Do not inherit the canvas dimensions or aspect ratio of the attached reference images."]
      : []),
    `Target canvas: ${orientation}, ${width / divisor}:${height / divisor} aspect ratio (nominal size ${width} x ${height} pixels).`,
    "Compose the final image for this aspect ratio.",
  ].join("\n");
}
