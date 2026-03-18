import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSerialRange } from "../src/core/sequence.js";

describe("serial outline sequencing", () => {
	it("creates strictly ordered range", () => {
		assert.deepEqual(buildSerialRange(1, 4), [1, 2, 3, 4]);
	});

	it("supports resume cursor", () => {
		assert.deepEqual(buildSerialRange(3, 5), [3, 4, 5]);
	});
});
