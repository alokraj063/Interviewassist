import type { FastifyInstance } from "fastify";
import { mongo } from "../mongo.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

  app.get("/health/db", async () => {
    const res = await mongo().command({ ping: 1 });
    return { db: "up", probe: res.ok === 1 };
  });
}
