import { sleep } from "./utils.js";

export class SlidingWindowRateLimiter {
	private readonly windowMs: number;
	private maxRequests: number;
	private readonly timestamps: number[] = [];
	private pending: Promise<void> = Promise.resolve();

	constructor(maxRequestsPerMinute: number) {
		this.windowMs = 60_000;
		this.maxRequests = Math.max(1, maxRequestsPerMinute);
	}

	setMaxRequestsPerMinute(value: number): void {
		this.maxRequests = Math.max(1, value);
	}

	async acquire(): Promise<void> {
		const slot = this.pending.then(async () => {
			while (true) {
				const now = Date.now();
				this.prune(now);
				if (this.timestamps.length < this.maxRequests) {
					this.timestamps.push(now);
					return;
				}
				const oldest = this.timestamps[0];
				const waitMs = Math.max(50, this.windowMs - (now - oldest));
				await sleep(waitMs);
			}
		});
		this.pending = slot.catch(() => undefined);
		await slot;
	}

	private prune(now: number): void {
		while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.windowMs) {
			this.timestamps.shift();
		}
	}
}

