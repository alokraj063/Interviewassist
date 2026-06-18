// One-shot demand sync. Repopulates the JoulesToWatts org's local
// demands/clients/assignments from the Offer Letter MySQL DB without
// spinning up the BullMQ worker loop.
//
// Run with:  pnpm --filter @j2w/worker exec tsx src/scripts/syncDemandsOnce.ts
//
// Safe to delete once the worker schedule covers your needs.
import "../env.js";
import pino from "pino";
import { JOULESTOWATTS_ORG_ID } from "@j2w/db";
import { processDemandSync } from "../jobs/offerLetterDemandSync.js";

const log = pino({ level: "info" });

async function main() {
  log.info({ orgId: JOULESTOWATTS_ORG_ID }, "starting one-shot demand sync");
  const result = await processDemandSync({ orgId: JOULESTOWATTS_ORG_ID }, log);
  log.info(result, "done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "demand sync failed");
    process.exit(1);
  });
