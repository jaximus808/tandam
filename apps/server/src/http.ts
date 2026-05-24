import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { imagesDir, getActiveId } from "./state.js";
import { newId } from "./entities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, "../../web/dist");
const DATA_DIR = join(process.cwd(), "canvas-data");

const ALLOWED_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

export async function registerHttp(fastify: FastifyInstance) {
  // Serve per-canvas images: /canvas-data/<canvasId>/images/<filename>
  await fastify.register(fastifyStatic, {
    root: DATA_DIR,
    prefix: "/canvas-data/",
    serve: true,
  });

  // Image upload — scoped to active canvas
  fastify.post("/api/images", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ error: "No file" });

    const ext = extname(data.filename).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return reply.status(400).send({ error: "Unsupported file type" });
    }

    const canvasId = getActiveId();
    const dir = imagesDir(canvasId);
    mkdirSync(dir, { recursive: true });

    const filename = `${newId()}${ext}`;
    const dest = join(dir, filename);
    const ws = createWriteStream(dest);

    await new Promise<void>((resolve, reject) => {
      data.file.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      data.file.on("error", reject);
    });

    return { filename, canvasId };
  });

  // Serve web app if built
  if (existsSync(WEB_DIST)) {
    await fastify.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/",
      decorateReply: false,
      wildcard: false,
    });

    fastify.setNotFoundHandler((_req, reply) => {
      return reply.sendFile("index.html", WEB_DIST);
    });
  } else {
    fastify.get("/", async () => ({
      message:
        "AgentCanvas server running. Web app not built — run `pnpm --filter web build` first, or start Vite dev server with `pnpm dev`.",
      canvas: "http://localhost:7891",
    }));
  }
}
