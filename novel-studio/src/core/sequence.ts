export function buildSerialRange(start: number, endInclusive: number): number[] {
	const output: number[] = [];
	for (let value = start; value <= endInclusive; value++) {
		output.push(value);
	}
	return output;
}
