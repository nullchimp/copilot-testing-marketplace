import { test, expect } from "@playwright/test";

// Original browser-free producer cases, including an intentional failure.
test("adds a pair", () => expect(1 + 1).toBe(2));
test("keeps an empty list empty", () => expect([]).toHaveLength(0));
test("intentional failure fixture", () => expect(1).toBe(2));
test.skip("explicitly skipped case", () => {});
test.fixme("future case", () => {});
