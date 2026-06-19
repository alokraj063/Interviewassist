import { env } from "./env.js";
import { buildServer } from "./server.js";
import { connectMongo, ensureIndexes } from "./mongo.js";

async function main() {
  await connectMongo();
  await ensureIndexes();
  const app = await buildServer();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`api listening on http://${env.API_HOST}:${env.API_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
