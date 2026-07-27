import { env } from "../env.js";
import { MongoClient } from "mongodb";
const id = process.argv[2];
const c = new MongoClient(env.MONGO_URL); await c.connect();
const r: any = await c.db(env.MONGO_DB).collection("ia_interviews").findOne({ id }, { projection: { _id: 0 } });
if (!r) console.log("NOT FOUND:", id);
else {
  const t = r.telephony ?? {};
  console.log("callId    :", r.id, "| interview status:", r.status);
  console.log("frejunId  :", t.frejunCallId);
  console.log("answerTime:", t.answerTime);
  console.log("endTime   :", t.endTime);
  console.log("status    :", t.status);
  console.log("history   :", JSON.stringify(t.statusHistory ?? [], null, 1));
}
await c.close();
