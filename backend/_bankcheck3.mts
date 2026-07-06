import { generateJdQuestionBank } from "./src/routes/assist.js";
const jd = "Senior Backend Engineer. Strong SQL (Postgres), Node.js/TypeScript, REST API design, Redis caching, query optimization and indexing.";
const bank = await generateJdQuestionBank(jd, "", { orgId: "smoketest", operation: "plan" });
const all = bank.skills.flatMap(s=>s.questions);
const byType = all.reduce((m,q)=>{ m[q.type||"?"]=(m[q.type||"?"]||0)+1; return m; },{});
console.log("total:", bank.total, "| types:", JSON.stringify(byType));
console.log("\nSAMPLE by type:");
for (const t of ["Query","Coding","Command","Concept","Scenario"]) {
  const q = all.find(x=>x.type===t);
  if(q){ console.log(`\n[${q.type} · ${q.difficulty}] ${q.question}`); console.log(`   → ${q.answer}`); }
}
process.exit(0);
