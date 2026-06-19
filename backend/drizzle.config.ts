import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://j2w:j2w_dev@localhost:5432/j2w",
  },
  strict: true,
  verbose: true,
});
