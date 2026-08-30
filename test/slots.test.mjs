import assert from "node:assert/strict";
import test from "node:test";
import { readSlotConfig } from "../src/slots.mjs";

test("readSlotConfig returns empty config when PI_BROKER_SLOTS is unset", () => {
  assert.deepEqual(readSlotConfig({}), {});
});

test("readSlotConfig parses a valid resource -> max map", () => {
  const config = readSlotConfig({
    PI_BROKER_SLOTS: '{"local-mlx":1,"qwencode":2}',
  });
  assert.deepEqual(config, { "local-mlx": 1, qwencode: 2 });
});

test("readSlotConfig rejects invalid JSON", () => {
  assert.throws(
    () => readSlotConfig({ PI_BROKER_SLOTS: "{not json" }),
    /valid JSON/,
  );
});

test("readSlotConfig rejects a non-object value", () => {
  assert.throws(
    () => readSlotConfig({ PI_BROKER_SLOTS: "[1,2,3]" }),
    /JSON object/,
  );
});

test("readSlotConfig rejects a non-positive-integer max", () => {
  assert.throws(
    () => readSlotConfig({ PI_BROKER_SLOTS: '{"local-mlx":0}' }),
    /positive integer/,
  );
  assert.throws(
    () => readSlotConfig({ PI_BROKER_SLOTS: '{"local-mlx":"one"}' }),
    /positive integer/,
  );
});
