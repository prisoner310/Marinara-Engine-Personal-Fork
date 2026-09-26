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
} from "../../packages/server/src/services/image/openai-chatgpt-image.js";
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
const dependencies = { getAuth: async () => auth, fetch: fakeFetch };

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
  prompt: "a red fox\n\nDo not include: text.",
  background: "opaque",
  quality: "auto",
  size: "1024x1024",
});
const headers = sentOptions?.headers as Record<string, string>;
assert.equal(headers.Authorization, `Bearer ${token}`);
assert.equal(headers["ChatGPT-Account-ID"], auth.accountId);
assert.match(headers["x-codex-image-turn-id"], /^[0-9a-f-]{36}$/u);
assert.equal(String(sentOptions?.body).includes(token), false);
assert.equal(sentOptions?.policy?.allowLocal, false);

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
  prompt: "change the pose\n\nDo not include: text.",
  background: "transparent",
  quality: "auto",
  size: "1280x720",
});
assert.equal((sentOptions?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
assert.equal((sentOptions?.headers as Record<string, string>)["ChatGPT-Account-ID"], auth.accountId);
assert.match((sentOptions?.headers as Record<string, string>)["x-codex-image-turn-id"], /^[0-9a-f-]{36}$/u);
assert.equal(String(sentOptions?.body).includes(token), false);

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
    const opaqueBody = JSON.parse(String(sentOptions?.body)) as { background: string; size: string };
    assert.equal(opaqueBody.background, "opaque");
    assert.equal(opaqueBody.size, "auto");
  }
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
