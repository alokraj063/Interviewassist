import type { FastifyInstance } from "fastify";

// Teams aren't used by the interview feature; minimal stub.
export async function teamsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.get("/", async () => ({ teams: [] }));
}
