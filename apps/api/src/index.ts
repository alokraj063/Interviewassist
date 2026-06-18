import { seedMockCalls } from "./dev/seedMockCalls.js";
import { env } from "./env.js";
import { buildServer } from "./server.js";

async function main() {
  const app = await buildServer();
  // Dev-only: materialize the frontend's mock CONVERSATIONS as call_sessions
  // so qa_reviews FKs resolve without ripping out the seeded dataset.
  if (env.NODE_ENV === "development") {
    try {
      await seedMockCalls(app.log);
    } catch (err) {
      app.log.warn({ err }, "seedMockCalls failed — continuing without mock rows");
    }
  }
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`api listening on http://${env.API_HOST}:${env.API_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
