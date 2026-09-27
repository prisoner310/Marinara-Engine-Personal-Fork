import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import {
  CODEX_CHATGPT_IMAGE_MODEL,
  IMAGE_GENERATION_SOURCES,
  inferImageSource,
} from "../../packages/shared/src/constants/model-lists.js";
import { generateImage, resolveImageBackend } from "../../packages/server/src/services/image/image-generation.js";
import {
  generateCodexChatGPTImage,
  getCodexChatGPTImageAuth,
  readCodexPngDimensions,
} from "../../packages/server/src/services/image/openai-chatgpt-image.js";
import { resolveImagePromptReviewProviderAdditions } from "../../packages/server/src/services/image/image-prompt-review.js";
import { OPENAI_CHATGPT_CODEX_BASE_URL } from "../../packages/server/src/services/llm/openai-chatgpt-auth.js";
import { connectionsRoutes } from "../../packages/server/src/routes/connections.routes.js";
import type { safeFetch } from "../../packages/server/src/utils/security.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const token = "synthetic-test-token-never-log";
const auth = {
  accessToken: token,
  accountId: "synthetic-account",
  planType: null,
  isFedrampAccount: false,
  authFilePath: "synthetic-auth.json",
  refreshed: false,
};

assert.equal(IMAGE_GENERATION_SOURCES.find((source) => source.id === "codex_chatgpt")?.requiresApiKey, false);
assert.equal(inferImageSource("codex_chatgpt", ""), "codex_chatgpt");
assert.equal(
  resolveImageBackend(
    CODEX_CHATGPT_IMAGE_MODEL,
    "https://image.pollinations.ai",
    "codex_chatgpt",
    CODEX_CHATGPT_IMAGE_MODEL,
  ),
  "codex_chatgpt",
);

let sentUrl = "";
let sentOptions: Parameters<typeof safeFetch>[1] | undefined;
let responseStatus = 200;
let responseBody: unknown = { data: [{ b64_json: png }] };
let networkFailure = false;
let fetchCalls = 0;
const diagnosticLines: string[] = [];
const fakeFetch = (async (url: string | URL, options?: Parameters<typeof safeFetch>[1]) => {
  fetchCalls += 1;
  sentUrl = String(url);
  sentOptions = options;
  if (networkFailure) throw new Error(`request failed with ${token}`);
  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { "content-type": "application/json" },
  });
}) as typeof safeFetch;
const dependencies = { getAuth: async () => auth, fetch: fakeFetch, debugLog: (line: string) => diagnosticLines.push(line) };

const pngHeader = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader);
pngHeader.writeUInt32BE(13, 8);
pngHeader.write("IHDR", 12, "ascii");
pngHeader.writeUInt32BE(1024, 16);
pngHeader.writeUInt32BE(1536, 20);
assert.deepEqual(readCodexPngDimensions(pngHeader), { width: 1024, height: 1536 });
assert.equal(readCodexPngDimensions(pngHeader.subarray(0, 23)), undefined);
assert.equal(readCodexPngDimensions(Buffer.from(png, "base64"))?.width, 1);
pngHeader.write("BAD!", 12, "ascii");
assert.equal(readCodexPngDimensions(pngHeader), undefined);

const result = await generateCodexChatGPTImage(
  {
    prompt: "a red fox",
    negativePrompt: "text",
    width: 1024,
    height: 1024,
    transparentBackground: false,
    model: "wrong-model",
  },
  dependencies,
);
assert.deepEqual(result, { base64: png, mimeType: "image/png", ext: "png" });
assert.equal(sentUrl, `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/generations`);
assert.equal(sentOptions?.method, "POST");
assert.deepEqual(JSON.parse(String(sentOptions?.body)), {
  model: CODEX_CHATGPT_IMAGE_MODEL,
  prompt:
    "a red fox\n\nTarget canvas: square, 1:1 aspect ratio (nominal size 1024 x 1024 pixels).\n" +
    "Compose the final image for this aspect ratio.\n\nDo not include: text.",
  background: "opaque",
  quality: "auto",
  size: "1024x1024",
});
const codexConnection = { imageService: "codex_chatgpt" };
const generationAddition = resolveImagePromptReviewProviderAdditions({
  connection: codexConnection,
  width: 1024,
  height: 1024,
});
assert.equal(
  (JSON.parse(String(sentOptions?.body)) as { prompt: string }).prompt,
  `a red fox\n\n${generationAddition}\n\nDo not include: text.`,
);
assert.equal(
  resolveImagePromptReviewProviderAdditions({ connection: { imageService: "openai" }, width: 1024, height: 1024 }),
  undefined,
);
assert.equal(resolveImagePromptReviewProviderAdditions({ connection: codexConnection, width: 0, height: 1024 }), undefined);
assert.equal(
  resolveImagePromptReviewProviderAdditions({
    connection: codexConnection,
    width: 1024,
    height: 1024,
    skipCodexCanvasHint: true,
  }),
  undefined,
);
const headers = sentOptions?.headers as Record<string, string>;
assert.equal(headers.Authorization, `Bearer ${token}`);
assert.equal(headers["ChatGPT-Account-ID"], auth.accountId);
assert.match(headers["x-codex-image-turn-id"], /^[0-9a-f-]{36}$/u);
assert.equal(String(sentOptions?.body).includes(token), false);
assert.equal(sentOptions?.policy?.allowLocal, false);
assert.match(diagnosticLines.at(-1) ?? "", /endpoint=generation requested=1024x1024 sent=1024x1024 response=<absent> actual=1x1/u);

for (const [width, height, orientation, ratio] of [
  [896, 1152, "portrait", "7:9"],
  [1280, 720, "landscape", "16:9"],
  [900, 1000, "portrait", "9:10"],
] as const) {
  await generateCodexChatGPTImage({ prompt: "a landscape or portrait", width, height }, dependencies);
  const body = JSON.parse(String(sentOptions?.body)) as { prompt: string; size: string };
  assert.equal(body.size, `${width}x${height}`);
  assert.ok(body.prompt.includes(`Target canvas: ${orientation}, ${ratio} aspect ratio`));
  assert.ok(body.prompt.includes(`nominal size ${width} x ${height} pixels`));
  assert.equal(body.prompt.includes("Do not inherit the canvas dimensions or aspect ratio"), false);
}

// Size metadata is observational: a declared size mismatch must not reject either route.
responseBody = {
  size: "1024x1536",
  background: "opaque",
  quality: "auto",
  data: [{ b64_json: png }],
};
for (const referenceImage of [undefined, png]) {
  const diagnosticPrompt = "private diagnostic prompt";
  const diagnosed = await generateCodexChatGPTImage(
    { prompt: diagnosticPrompt, referenceImage, width: 896, height: 1280 },
    dependencies,
  );
  assert.deepEqual(diagnosed, { base64: png, mimeType: "image/png", ext: "png" });
  assert.equal(sentUrl, `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/${referenceImage ? "edits" : "generations"}`);
  assert.equal(JSON.parse(String(sentOptions?.body)).size, "896x1280");
  const diagnostic = diagnosticLines.at(-1) ?? "";
  assert.match(
    diagnostic,
    new RegExp(
      `endpoint=${referenceImage ? "edit" : "generation"} requested=896x1280 sent=896x1280 ` +
        "response=1024x1536 actual=1x1 background=opaque quality=auto",
      "u",
    ),
  );
  for (const secret of [token, auth.accountId, diagnosticPrompt, png]) assert.equal(diagnostic.includes(secret), false);
}
responseBody = { data: [{ b64_json: png }] };
await generateCodexChatGPTImage({ prompt: "metadata absent", width: 896, height: 1280 }, dependencies);
assert.match(diagnosticLines.at(-1) ?? "", /response=<absent> actual=1x1 background=<absent> quality=<absent>/u);
responseBody = { size: token, background: token, quality: token, data: [{ b64_json: png }] };
await generateCodexChatGPTImage({ prompt: "untrusted metadata" }, dependencies);
assert.match(diagnosticLines.at(-1) ?? "", /response=<absent> actual=1x1 background=<absent> quality=<absent>/u);
assert.equal((diagnosticLines.at(-1) ?? "").includes(token), false);
responseBody = { data: [{ b64_json: png }] };

// Empty references retain Phase 1's generation route and request shape.
await generateCodexChatGPTImage(
  { prompt: "a red fox", referenceImage: " ", referenceImages: ["", "  "] },
  dependencies,
);
assert.equal(sentUrl, `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/generations`);
assert.equal("images" in JSON.parse(String(sentOptions?.body)), false);

const edited = await generateCodexChatGPTImage(
  {
    prompt: "change the pose",
    negativePrompt: "text",
    referenceImage: png,
    width: 1280,
    height: 720,
    transparentBackground: true,
  },
  dependencies,
);
assert.deepEqual(edited, { base64: png, mimeType: "image/png", ext: "png" });
assert.equal(sentUrl, `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/edits`);
assert.equal(sentOptions?.method, "POST");
assert.deepEqual(JSON.parse(String(sentOptions?.body)), {
  images: [{ image_url: `data:image/png;base64,${png}` }],
  model: CODEX_CHATGPT_IMAGE_MODEL,
  prompt:
    "change the pose\n\n" +
    "Do not inherit the canvas dimensions or aspect ratio of the attached reference images.\n" +
    "Target canvas: landscape, 16:9 aspect ratio (nominal size 1280 x 720 pixels).\n" +
    "Compose the final image for this aspect ratio.\n\nDo not include: text.",
  background: "transparent",
  quality: "auto",
  size: "1280x720",
});
assert.equal((sentOptions?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
assert.equal((sentOptions?.headers as Record<string, string>)["ChatGPT-Account-ID"], auth.accountId);
assert.match((sentOptions?.headers as Record<string, string>)["x-codex-image-turn-id"], /^[0-9a-f-]{36}$/u);
assert.equal(String(sentOptions?.body).includes(token), false);

// Reference meaning belongs to the main prompt; the Codex-only addition controls canvas shape only.
const mainReferencePrompt = "Use the image for location and character likeness; follow the written art style.";
await generateCodexChatGPTImage(
  { prompt: mainReferencePrompt, referenceImage: png, width: 896, height: 1152 },
  dependencies,
);
const sentReferencePrompt = (JSON.parse(String(sentOptions?.body)) as { prompt: string }).prompt;
assert.ok(sentReferencePrompt.startsWith(`${mainReferencePrompt}\n\n`));
const addedCanvasHint = sentReferencePrompt.slice(mainReferencePrompt.length + 2);
const reviewedCanvasHint = resolveImagePromptReviewProviderAdditions({
  connection: codexConnection,
  width: 896,
  height: 1152,
  hasReferences: true,
});
assert.equal(addedCanvasHint, reviewedCanvasHint);
assert.equal(
  addedCanvasHint,
  "Do not inherit the canvas dimensions or aspect ratio of the attached reference images.\n" +
    "Target canvas: portrait, 7:9 aspect ratio (nominal size 896 x 1152 pixels).\n" +
    "Compose the final image for this aspect ratio.",
);
for (const role of [
  "subject identity",
  "character identity",
  "visual details",
  "art style",
  "character likeness",
  "location",
  "requested edit",
]) {
  assert.equal(addedCanvasHint.toLowerCase().includes(role), false);
}

// Generation and edit share background/size mapping, including invalid dimensions.
for (const referenceImage of [undefined, png]) {
  const url = `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/${referenceImage ? "edits" : "generations"}`;
  await generateCodexChatGPTImage(
    { prompt: "transparent subject", referenceImage, width: 1280, height: 720, transparentBackground: true },
    dependencies,
  );
  assert.equal(sentUrl, url);
  const transparentBody = JSON.parse(String(sentOptions?.body)) as { background: string; size: string };
  assert.equal(transparentBody.background, "transparent");
  assert.equal(transparentBody.size, "1280x720");
  for (const dimensions of [
    { width: undefined, height: 1024 },
    { width: 1024, height: undefined },
    { width: 0, height: 1024 },
    { width: Number.POSITIVE_INFINITY, height: 1024 },
    { width: 1024.5, height: 1024 },
  ]) {
    await generateCodexChatGPTImage({ prompt: "opaque subject", referenceImage, ...dimensions }, dependencies);
    const opaqueBody = JSON.parse(String(sentOptions?.body)) as { background: string; size: string; prompt: string };
    assert.equal(opaqueBody.background, "opaque");
    assert.equal(opaqueBody.size, "auto");
    assert.equal(opaqueBody.prompt, "opaque subject");
  }
}

// Sprite callers keep their existing canvas contract, with no second generic instruction.
for (const referenceImage of [undefined, png]) {
  await generateCodexChatGPTImage(
    {
      prompt: "MANDATORY SPRITE SHEET LAYOUT: target output canvas is 1024x1536 pixels.",
      negativePrompt: "blur",
      width: 1024,
      height: 1536,
      referenceImage,
      skipCodexCanvasHint: true,
    },
    dependencies,
  );
  const body = JSON.parse(String(sentOptions?.body)) as { prompt: string; size: string };
  assert.equal(body.size, "1024x1536");
  assert.equal(body.prompt, "MANDATORY SPRITE SHEET LAYOUT: target output canvas is 1024x1536 pixels.\n\nDo not include: blur.");
}

await generateCodexChatGPTImage({ prompt: "edit", referenceImage: `data:image/png;base64,${png}` }, dependencies);
assert.deepEqual(JSON.parse(String(sentOptions?.body)).images, [{ image_url: `data:image/png;base64,${png}` }]);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
const webp = Buffer.from("RIFF0000WEBPVP8 ").toString("base64");
await generateCodexChatGPTImage(
  { prompt: "edit", referenceImage: png, referenceImages: [png, jpeg, webp, `data:image/png;base64,${png}`] },
  dependencies,
);
assert.deepEqual(JSON.parse(String(sentOptions?.body)).images, [
  { image_url: `data:image/png;base64,${png}` },
  { image_url: `data:image/jpeg;base64,${jpeg}` },
  { image_url: `data:image/webp;base64,${webp}` },
]);

const distinctPngs = Array.from({ length: 6 }, (_, index) =>
  Buffer.concat([Buffer.from(png, "base64"), Buffer.from([index])]).toString("base64"),
);
await generateCodexChatGPTImage(
  { prompt: "edit", referenceImage: distinctPngs[0], referenceImages: distinctPngs.slice(1, 5) },
  dependencies,
);
assert.equal(JSON.parse(String(sentOptions?.body)).images.length, 5);
const fetchCallsBeforeRejectedReferences = fetchCalls;
await assert.rejects(
  generateCodexChatGPTImage(
    { prompt: "edit", referenceImage: distinctPngs[0], referenceImages: distinctPngs.slice(1) },
    dependencies,
  ),
  /up to 5 reference images, but 6 were provided/u,
);
assert.equal(fetchCalls, fetchCallsBeforeRejectedReferences);

for (const referenceImage of [
  "data:image/png;base64,",
  "data:image/png;utf8,broken",
  "not-an-image",
  "https://example.com/image.png",
  `data:image/jpeg;base64,${png}`,
]) {
  await assert.rejects(
    generateCodexChatGPTImage({ prompt: "edit", referenceImage }, dependencies),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /reference image/u);
      assert.equal(error.message.includes(referenceImage), false);
      return true;
    },
  );
}
assert.equal(fetchCalls, fetchCallsBeforeRejectedReferences);

responseBody = { data: [{ b64_json: png, generation_id: "synthetic-generation-id" }] };
assert.deepEqual(await generateCodexChatGPTImage({ prompt: "edit", referenceImage: png }, dependencies), edited);

const generate = () => generateCodexChatGPTImage({ prompt: "a red fox" }, dependencies);
responseBody = { data: [] };
await assert.rejects(generate(), /returned no image data/u);
responseBody = { data: [{ b64_json: "not-an-image" }] };
await assert.rejects(generate(), /invalid PNG/u);
responseBody = { unexpected: "shape" };
await assert.rejects(generate(), /invalid image response/u);

for (const [status, body, expected] of [
  [401, { error: { message: token } }, /Run `codex login` again/u],
  [403, { error: { message: token } }, /not allowed/u],
  [429, { error: { message: token } }, /usage limit/u],
  [400, { error: { code: "usage_limit_reached", message: token } }, /usage limit/u],
  [503, { error: { message: token } }, /HTTP 503/u],
] as const) {
  responseStatus = status;
  responseBody = body;
  await assert.rejects(generate(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.equal(error.message.includes(token), false);
    return true;
  });
}
responseStatus = 200;
networkFailure = true;
await assert.rejects(generate(), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Could not reach/u);
  assert.equal(error.message.includes(token), false);
  return true;
});
networkFailure = false;

const edit = () => generateCodexChatGPTImage({ prompt: "edit this", referenceImage: png }, dependencies);
for (const [status, expected] of [
  [401, /Run `codex login` again/u],
  [403, /not allowed/u],
  [429, /usage limit/u],
  [400, /HTTP 400/u],
  [503, /HTTP 503/u],
] as const) {
  responseStatus = status;
  responseBody = { error: { message: `private payload ${token} ${png}` } };
  await assert.rejects(edit(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(png), false);
    return true;
  });
  assert.equal(sentUrl, `${OPENAI_CHATGPT_CODEX_BASE_URL}/images/edits`);
}
responseStatus = 200;
responseBody = { data: [] };
await assert.rejects(edit(), /returned no image data/u);
networkFailure = true;
await assert.rejects(edit(), /Could not reach/u);
networkFailure = false;

const previousCodexHome = process.env.CODEX_HOME;
const previousStorageDir = process.env.FILE_STORAGE_DIR;
const directory = mkdtempSync(join(tmpdir(), "marinara-codex-image-"));
const app = Fastify();
let db:
  | Awaited<ReturnType<typeof import("../../packages/server/src/db/file-backed-store.js").createFileNativeDB>>
  | undefined;
try {
  process.env.CODEX_HOME = join(directory, "codex-home");
  process.env.FILE_STORAGE_DIR = join(directory, "storage");
  await assert.rejects(getCodexChatGPTImageAuth(), /codex login/u);
  // This goes through generateImage's real backend switch and must fail on auth before any network request.
  await assert.rejects(
    generateImage(CODEX_CHATGPT_IMAGE_MODEL, "https://image.pollinations.ai", "", "codex_chatgpt", {
      prompt: "a red fox",
      model: CODEX_CHATGPT_IMAGE_MODEL,
    }),
    /codex login/u,
  );
  await assert.rejects(
    generateImage(CODEX_CHATGPT_IMAGE_MODEL, "https://image.pollinations.ai", "", "codex_chatgpt", {
      prompt: "edit a red fox",
      model: CODEX_CHATGPT_IMAGE_MODEL,
      referenceImage: png,
    }),
    /codex login/u,
  );

  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  db = await createFileNativeDB();
  app.decorate("db", db);
  await app.register(connectionsRoutes, { prefix: "/api/connections" });
  const created = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: {
      name: "ChatGPT image test",
      provider: "image_generation",
      baseUrl: "",
      apiKey: "",
      model: CODEX_CHATGPT_IMAGE_MODEL,
      imageGenerationSource: "codex_chatgpt",
      imageService: "codex_chatgpt",
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id as string;

  const missingLogin = await app.inject({ method: "POST", url: `/api/connections/${id}/test` });
  assert.equal(missingLogin.json().success, false);
  assert.match(missingLogin.json().message, /codex login/u);

  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(codexHome, { recursive: true });
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expiredToken } }),
  );
  await assert.rejects(getCodexChatGPTImageAuth(), /login has expired or could not be refreshed/u);
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: auth.accountId } }),
  );
  const test = await app.inject({ method: "POST", url: `/api/connections/${id}/test` });
  assert.equal(test.json().success, true, test.body);
  assert.equal(test.json().message.includes(token), false);
  const models = await app.inject({ method: "GET", url: `/api/connections/${id}/models` });
  assert.deepEqual(models.json().models, [{ id: CODEX_CHATGPT_IMAGE_MODEL, name: "GPT Image 2 (ChatGPT / Codex)" }]);
} finally {
  await app.close();
  await db?._fileStore.close();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  const temporaryRoot = realpathSync(tmpdir());
  const temporaryDirectory = realpathSync(directory);
  assert.ok(temporaryDirectory.startsWith(`${temporaryRoot}${sep}`));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.info("Codex ChatGPT image regression passed");
