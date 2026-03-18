import { existsSync } from "node:fs";
import { join } from "node:path";
import { startNovelStudioServer } from "./server.js";

const port = Number.parseInt(process.env.NOVEL_STUDIO_PORT || "4310", 10);
const dataDir = process.env.NOVEL_STUDIO_DATA_DIR || join(process.cwd(), "data");
const distPublicDir = join(process.cwd(), "dist", "public");
const srcPublicDir = join(process.cwd(), "src", "public");
const publicDir = existsSync(distPublicDir) ? distPublicDir : srcPublicDir;

const server = await startNovelStudioServer({
	port,
	dataDir,
	publicDir,
});

const close = () => {
	server.close(() => {
		process.exit(0);
	});
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

console.log(`Novel Studio running at http://127.0.0.1:${port}`);
console.log(`Data directory: ${dataDir}`);
