import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "@j2w/db";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", ts: Date.now() }));

  app.get("/health/db", async () => {
    const result = (await db.execute(sql`select 1 as ok`)) as unknown as {
      rows?: Array<{ ok: number }>;
    };
    const rows = result.rows ?? (result as unknown as Array<{ ok: number }>);
    return { db: "up", probe: rows[0]?.ok === 1 };
  });
}
