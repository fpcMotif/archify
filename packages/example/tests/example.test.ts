import { expect, test } from "bun:test";
import { greet } from "../index.ts";

test("greet capitalizes the name", () => {
  expect(greet("ada")).toBe("Hello, Ada!");
});

test("greet falls back to world for a blank name", () => {
  expect(greet("  ")).toBe("Hello, World!");
});
