// Throwaway diagnostic: dump the telephony status history of the most recent
// calls, so a stuck "Ringing…" can be traced to the exact status sequence.
import { env } from "../env.js";
import { MongoClient } from "mongodb";
const c = new MongoClient(env.MONGO_URL);
await c.connect();
const col = c.db(env.MONGO_DB).collection("ia_interviews");
const rows = await col.find({}, { projection: { _id: 0, id: 1, status: 1, startedAt: 1, telephony: 1 } })
  .sort({ startedAt: -1 }).limit(4).toArray();
for (const r of rows) {
  const t: any = r.telephony ?? {};
  console.log("─".repeat(70));
  console.log("call", r.id, "| interview status:", r.status);
  console.log("  direction :", t.direction, "| telephony.status:", t.status);
  console.log("  frejunId  :", t.frejunCallId);
  console.log("  answerTime:", t.answerTime, "| endTime:", t.endTime);
  console.log("  history   :", JSON.stringify(t.statusHistory ?? []));
}
await c.close();
