import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

test("ChatGPT/Codex image connection needs no API key or Base URL and keeps its fixed model", async ({
  page,
  request,
}, testInfo) => {
  await seedUIState(page, { hasCompletedOnboarding: true, rightPanelOpen: false, sidebarOpen: false });
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, APP_VERSION);
  const created = await request.post("/api/connections", {
    data: {
      name: `Codex image fixture ${testInfo.project.name}`,
      provider: "image_generation",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "synthetic-key",
      model: "gpt-image-2.5-flare",
      imageGenerationSource: "openai",
      imageService: "openai",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  try {
    await page.goto("/");
    await page.evaluate(async (connectionId) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().openConnectionDetail(connectionId);
    }, id);
    const editor = page.locator(".mari-editor-shell").filter({ has: page.getByPlaceholder("Connection name") });
    await expect(editor.getByPlaceholder("Connection name")).toBeVisible();
    await expect
      .poll(async () => (await (await request.get(`/api/connections/${id}`)).json()).apiKeyEncrypted)
      .toBe("••••••••");
    await editor.getByRole("button", { name: /ChatGPT \/ Codex Image/u }).click();
    await expect(editor.getByRole("heading", { name: "API Key", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("heading", { name: "Base URL", exact: true })).toHaveCount(0);
    await expect(editor.getByText("GPT Image 2 (gpt-image-2) — fixed for this connection")).toBeVisible();
    await expect(editor.getByText(/Run codex login on the Marinara host first/u)).toBeVisible();
    await expect(editor.getByText(/edits up to 5 reference images/u)).toBeVisible();
    await expect(editor.getByText(/Requested width and height guide the target aspect ratio/u)).toBeVisible();
    await expect(editor.getByText(/Exact output pixel dimensions may differ/u)).toBeVisible();
    await editor.getByRole("button", { name: "Save", exact: true }).click();

    await expect
      .poll(async () => {
        const connection = await (await request.get(`/api/connections/${id}`)).json();
        return {
          baseUrl: connection.baseUrl,
          apiKeyEncrypted: connection.apiKeyEncrypted,
          model: connection.model,
          imageGenerationSource: connection.imageGenerationSource,
          imageService: connection.imageService,
        };
      })
      .toEqual({
        baseUrl: "",
        apiKeyEncrypted: "",
        model: "gpt-image-2",
        imageGenerationSource: "codex_chatgpt",
        imageService: "codex_chatgpt",
      });
  } finally {
    await request.delete(`/api/connections/${id}`);
  }
});

test("Codex avatar prompt preview shows the canvas addition without editing the prompt", async ({
  request,
}, testInfo) => {
  const created = await request.post("/api/connections", {
    data: {
      name: `Codex prompt preview ${testInfo.project.name}`,
      provider: "image_generation",
      model: "gpt-image-2",
      imageGenerationSource: "codex_chatgpt",
      imageService: "codex_chatgpt",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  try {
    for (const referenceImages of [undefined, [`data:image/png;base64,${png}`]]) {
      const preview = await request.post("/api/characters/avatar-generation/preview", {
        data: {
          connectionId: id,
          name: "Preview character",
          appearance: "Blue coat",
          width: 896,
          height: 1152,
          referenceImages,
        },
      });
      expect(preview.ok(), await preview.text()).toBeTruthy();
      const { items } = (await preview.json()) as {
        items: Array<{ prompt: string; providerAdditions?: string }>;
      };
      expect(items).toHaveLength(1);
      expect(items[0]?.prompt).not.toContain("Target canvas:");
      expect(items[0]?.providerAdditions).toContain("Target canvas: portrait, 7:9 aspect ratio");
      if (referenceImages) {
        expect(items[0]?.providerAdditions).toContain("Do not inherit the canvas dimensions or aspect ratio");
      } else {
        expect(items[0]?.providerAdditions).not.toContain("Do not inherit the canvas dimensions or aspect ratio");
      }
    }
  } finally {
    await request.delete(`/api/connections/${id}`);
  }
});

test("sprite prompt preview uses native alpha for Codex while Platform GPT-Image 2 keeps chroma fallback", async ({
  request,
}, testInfo) => {
  const connectionIds: string[] = [];
  try {
    for (const service of ["codex_chatgpt", "openai"] as const) {
      const created = await request.post("/api/connections", {
        data: {
          name: `${service} sprite preview ${testInfo.project.name}`,
          provider: "image_generation",
          baseUrl: service === "openai" ? "https://api.openai.com/v1" : "",
          apiKey: service === "openai" ? "synthetic-key" : "",
          model: "gpt-image-2",
          imageGenerationSource: service,
          imageService: service,
        },
      });
      expect(created.ok()).toBeTruthy();
      const { id } = (await created.json()) as { id: string };
      connectionIds.push(id);
      const preview = await request.post("/api/sprites/generate-sheet/preview", {
        data: {
          connectionId: id,
          appearance: "black hair, red coat",
          expressions: ["happy"],
          cols: 1,
          rows: 1,
          spriteType: "expressions",
          nativeTransparentPng: true,
          noBackground: true,
        },
      });
      expect(preview.ok(), await preview.text()).toBeTruthy();
      const { items } = (await preview.json()) as { items: Array<{ prompt: string; providerAdditions?: string }> };
      expect(items).toHaveLength(1);
      expect(items[0]?.providerAdditions).toBeUndefined();
      if (service === "codex_chatgpt") {
        expect(items[0]?.prompt).toContain("native transparency");
        expect(items[0]?.prompt).not.toMatch(/chroma|#00FF00/iu);
      } else {
        expect(items[0]?.prompt).toMatch(/chroma green #00FF00/iu);
      }
    }
  } finally {
    for (const id of connectionIds) await request.delete(`/api/connections/${id}`);
  }
});
