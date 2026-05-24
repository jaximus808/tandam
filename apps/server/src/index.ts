import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import { loadAll, registerBroadcast } from "./state.js";
import { startMcp } from "./mcp.js";
import { broadcast, registerWs } from "./ws.js";
import { registerHttp } from "./http.js";

const PORT = 7892;

async function main() {
  loadAll();
  registerBroadcast(broadcast);

  await startMcp();

  const fastify = Fastify({
    logger: { stream: process.stderr },
  });

  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  registerWs(fastify);
  await registerHttp(fastify);

  try {
    await fastify.listen({ port: PORT, host: "127.0.0.1" });
    process.stderr.write(`\nCanvas open at http://localhost:${PORT}\n\n`);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "EADDRINUSE") {
      process.stderr.write(
        `\n[agentcanvas] WARNING: Port ${PORT} is already in use — canvas UI unavailable.\n` +
        `Free port ${PORT} and restart for the browser canvas to work.\n` +
        `MCP tools (canvas.state.read, canvas.pin.add, etc.) are still active.\n\n`
      );
    } else {
      process.stderr.write(`[agentcanvas] HTTP server failed: ${err}\nMCP tools still active.\n`);
    }
    // Do NOT exit — keep MCP stdio alive so Claude can still use the tools
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
