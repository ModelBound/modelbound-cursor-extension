import assert from "node:assert/strict";
import test from "node:test";
import { VERDICTS } from "./feedbackVocabulary.js";

test("outcomes verdicts match CLI / MCP vocabulary", () => {
  assert.deepEqual([...VERDICTS], ["worked", "partial", "failed"]);
});
