import type { ServerResponse } from "node:http";
import type { ProjectEvent } from "./types.js";

export class SseHub {
	private readonly subscribers = new Map<string, Set<ServerResponse>>();

	subscribe(projectId: string, res: ServerResponse): void {
		let set = this.subscribers.get(projectId);
		if (!set) {
			set = new Set<ServerResponse>();
			this.subscribers.set(projectId, set);
		}
		set.add(res);
	}

	unsubscribe(projectId: string, res: ServerResponse): void {
		const set = this.subscribers.get(projectId);
		if (!set) {
			return;
		}
		set.delete(res);
		if (set.size === 0) {
			this.subscribers.delete(projectId);
		}
	}

	broadcast(projectId: string, event: ProjectEvent): void {
		const set = this.subscribers.get(projectId);
		if (!set || set.size === 0) {
			return;
		}
		const payload = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
		for (const res of set) {
			res.write(payload);
		}
	}
}
