import test from "node:test";
import assert from "node:assert/strict";

import { QuitDetector } from "../quitDetector.js";

test("QuitDetector triggers on two escape presses within the time window", () => {
  const detector = new QuitDetector();

  assert.equal(detector.registerKeypress("\u001b"), false);
  assert.equal(detector.registerKeypress("\u001b"), true);
});

test("QuitDetector resets after other input", () => {
  const detector = new QuitDetector();

  assert.equal(detector.registerKeypress("\u001b"), false);
  assert.equal(detector.registerKeypress("a"), false);
  assert.equal(detector.registerKeypress("\u001b"), false);
});

test("QuitDetector ignores delayed second escape", async () => {
  const detector = new QuitDetector();

  assert.equal(detector.registerKeypress("\u001b"), false);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(detector.registerKeypress("\u001b"), false);
});
