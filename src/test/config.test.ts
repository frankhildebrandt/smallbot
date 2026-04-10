import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfigFromRoot } from "../config.js";
import { resolveSandboxMode } from "../process/bubblewrap.js";

async function createTempProject(settings: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "smallbot-config-test-"));
  await mkdir(path.join(rootDir, "module", "ai-free", "dist"), { recursive: true });
  await mkdir(path.join(rootDir, "module", "rag-basic", "dist"), { recursive: true });
  await writeFile(path.join(rootDir, "module", "ai-free", "dist", "index.js"), "console.log('ai');\n");
  await writeFile(path.join(rootDir, "module", "rag-basic", "dist", "index.js"), "console.log('rag');\n");
  await writeFile(path.join(rootDir, "settings.yml"), settings);
  return rootDir;
}

test("loadConfigFromRoot maps settings.yml into app config", async (t) => {
  const rootDir = await createTempProject(`
runtimeDir: ".smallbot-runtime"
sandboxMode: "process"
services:
  - name: "ai:1"
    kind: "ai"
    module: "ai-free"
    permissions:
      networking: true
    environment:
      OPEN_AI_KEY: "secret"
`);

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const config = loadConfigFromRoot(rootDir);

  assert.equal(config.runtimeDir, path.join(rootDir, ".smallbot-runtime"));
  assert.equal(config.sandboxMode, "process");
  assert.equal(config.modules.length, 1);
  assert.deepEqual(config.modules[0], {
    name: "ai:1",
    kind: "ai",
    entryScript: path.join(rootDir, "module", "ai-free", "dist", "index.js"),
    env: {
      OPEN_AI_KEY: "secret",
    },
    permissions: {
      networking: true,
    },
  });
});

test("loadConfigFromRoot preserves service order for multiple modules", async (t) => {
  const rootDir = await createTempProject(`
services:
  - name: "ai:1"
    kind: "ai"
    module: "ai-free"
    permissions:
      networking: true
  - name: "rag:1"
    kind: "rag"
    module: "rag-basic"
    permissions:
      networking: true
`);

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const config = loadConfigFromRoot(rootDir);

  assert.deepEqual(
    config.modules.map((moduleConfig) => moduleConfig.name),
    ["ai:1", "rag:1"],
  );
});

test("loadConfigFromRoot rejects missing required service fields", async (t) => {
  const rootDir = await createTempProject(`
services:
  - name: "ai:1"
    module: "ai-free"
    permissions:
      networking: true
`);

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.throws(() => loadConfigFromRoot(rootDir), /services\[0\]\.kind must be a non-empty string/);
});

test("loadConfigFromRoot rejects enviroment typo", async (t) => {
  const rootDir = await createTempProject(`
services:
  - name: "ai:1"
    kind: "ai"
    module: "ai-free"
    permissions:
      networking: true
    enviroment:
      OPEN_AI_KEY: "secret"
`);

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.throws(() => loadConfigFromRoot(rootDir), /services\[0\]\.enviroment is invalid; use environment/);
});

test("loadConfigFromRoot rejects missing module builds", async (t) => {
  const rootDir = await createTempProject(`
services:
  - name: "ai:1"
    kind: "ai"
    module: "missing-module"
    permissions:
      networking: true
`);

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.throws(() => loadConfigFromRoot(rootDir), /Configured module "missing-module" does not exist/);
});

test("loadConfigFromRoot requires settings.yml", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "smallbot-config-test-"));

  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  assert.throws(() => loadConfigFromRoot(rootDir), /Missing required settings file/);
});

test("resolveSandboxMode enforces networking=false on unsupported platforms", async () => {
  if (process.platform === "linux") {
    try {
      const mode = await resolveSandboxMode("auto", { networking: false });
      assert.equal(mode, "bwrap");
    } catch (error) {
      assert.match((error as Error).message, /requires bubblewrap to be installed/);
    }
    return;
  }

  await assert.rejects(
    resolveSandboxMode("auto", { networking: false }),
    /permissions\.networking=false requires Linux bubblewrap isolation/,
  );
});
