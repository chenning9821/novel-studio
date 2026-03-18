import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureWithinTolerance } from "../src/core/utils.js";

describe("word budget tolerance", () => {
	it("accepts value inside tolerance window", () => {
		assert.equal(ensureWithinTolerance(108, 100, 0.15), true);
		assert.equal(ensureWithinTolerance(86, 100, 0.15), true);
	});

	it("rejects value outside tolerance window", () => {
		assert.equal(ensureWithinTolerance(120, 100, 0.15), false);
		assert.equal(ensureWithinTolerance(70, 100, 0.15), false);
	});
});
