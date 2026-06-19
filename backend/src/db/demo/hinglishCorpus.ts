// Hand-written Hinglish dialogue snippets that drive `transcript_turns.text`,
// `prospect_calls.summary`, and call summaries. Recruiter UI copy is English
// throughout the project; this file is the boundary where candidate-facing
// content lives in code-mix.

export interface DialogueTurn {
  speaker: "recruiter" | "candidate" | "unknown";
  text: string;
  durationSec: number;
}

// Each dialogue is a complete recruiter screening conversation (~25-35 turns).
// Keep them realistic-but-anonymous; mention generic role/skill/CTC details so
// they read coherent against any seeded demand.
const GENERAL_SCREEN_DIALOGUE: DialogueTurn[] = [
  { speaker: "recruiter", text: "Hi, am I speaking with Aarav? Main RecruitAssist se Asha bol rahi hoon. Senior backend role ke baare mein call kar rahi thi — do you have 5 minutes?", durationSec: 7 },
  { speaker: "candidate", text: "Haan haan, Aarav speaking. Bolo Asha ji.", durationSec: 3 },
  { speaker: "recruiter", text: "Thank you. Currently aap kahan kaam kar rahe ho aur designation kya hai?", durationSec: 4 },
  { speaker: "candidate", text: "Main abhi Razorpay mein hoon, Senior Software Engineer as a backend engineer — payments team mein.", durationSec: 6 },
  { speaker: "recruiter", text: "Got it. Aap actively looking ho na — ya casually browse kar rahe ho?", durationSec: 4 },
  { speaker: "candidate", text: "Actively looking. Last 6 months mein progression kuch slow hai, isliye external opportunities dekh raha hoon.", durationSec: 7 },
  { speaker: "recruiter", text: "Theek hai. Aapka tech stack — Java aur Spring Boot dono use karte ho?", durationSec: 4 },
  { speaker: "candidate", text: "Java + Spring Boot mainly, plus Kafka for async. PostgreSQL is the primary DB. Some AWS — EKS, RDS, SQS.", durationSec: 8 },
  { speaker: "recruiter", text: "Perfect alignment hai. Aapka current CTC kya hai roughly — fixed component?", durationSec: 5 },
  { speaker: "candidate", text: "Fixed 28 lakhs hai, plus 4 lakh variable. Total around 32 LPA.", durationSec: 5 },
  { speaker: "recruiter", text: "Aur expectation kya rakh rahe ho?", durationSec: 3 },
  { speaker: "candidate", text: "Looking at 40-45 fixed at minimum. Variable on top.", durationSec: 4 },
  { speaker: "recruiter", text: "Note kar liya. Notice period kitna hai aapka?", durationSec: 4 },
  { speaker: "candidate", text: "60 days hai officially, but maybe negotiable to 30-45 if buyout option there.", durationSec: 6 },
  { speaker: "recruiter", text: "Theek hai. Currently Bengaluru mein hi ho? Aur location preference?", durationSec: 4 },
  { speaker: "candidate", text: "Bengaluru mein hoon abhi. Open to Pune ya Hyderabad bhi if right opportunity. Hybrid prefer karoonga, full remote tough hai for me.", durationSec: 9 },
  { speaker: "recruiter", text: "Perfect. Ek client GCC hai — fintech space — Bengaluru-based, hybrid model. Senior backend role with strong distributed systems exposure. Recruiter aapko within 24 hours full JD bhejega — that work karega?", durationSec: 11 },
  { speaker: "candidate", text: "Haan that works. Ek question — interview process kitna lamba hai?", durationSec: 5 },
  { speaker: "recruiter", text: "Roughly 3 rounds — L1 technical, L2 system design, then HR. Total 2-3 weeks usually.", durationSec: 6 },
  { speaker: "candidate", text: "Okay theek hai. Interview rounds video call pe hi honge na?", durationSec: 4 },
  { speaker: "recruiter", text: "Haan, sab video on Google Meet. L1-L2 panel ke baad final discussion in person ho sakta hai but mostly video.", durationSec: 7 },
  { speaker: "candidate", text: "Got it. JD bhejna please.", durationSec: 3 },
  { speaker: "recruiter", text: "Bilkul. Recruiter Anjali aapko aaj shaam tak email karegi. Anything else aap mention karna chahte ho?", durationSec: 6 },
  { speaker: "candidate", text: "Nahi bas — agar JD interesting lagi to definitely interview ke liye time nikal lunga.", durationSec: 5 },
  { speaker: "recruiter", text: "Bahut shukriya Aarav. Aapka time appreciate karte hain. Have a great day!", durationSec: 4 },
  { speaker: "candidate", text: "Thank you, alvida.", durationSec: 2 },
];

const TECHNICAL_SCREEN_DIALOGUE: DialogueTurn[] = [
  { speaker: "recruiter", text: "Hi Vihaan, this is Rohan from RecruitAssist. I have a 10-minute technical conversation tied to the senior backend role. Aap free ho?", durationSec: 7 },
  { speaker: "candidate", text: "Yes, free hoon. Go ahead.", durationSec: 3 },
  { speaker: "recruiter", text: "Walk me through the most complex production system aapne last 12 months mein owned kiya — failure modes ke saath.", durationSec: 7 },
  { speaker: "candidate", text: "Sure. Maine ek payment reconciliation pipeline owned kiya — daily 5 million transactions reconcile karte the multiple gateways ke saath. Failure modes mainly do the: gateway downtime aur duplicate webhook delivery. Idempotency keys use kiye sab events ke liye, aur retry queue mein exponential backoff with DLQ at 5 attempts.", durationSec: 19 },
  { speaker: "recruiter", text: "Good. Concurrency wise — JVM pe agar 500 threads run kar rahe ho, kya considerations hote hain?", durationSec: 7 },
  { speaker: "candidate", text: "Pehle to thread pool sizing — IO-bound workloads ke liye more threads, CPU-bound for Number_of_cores * 2 type. Lock contention bachne ke liye fine-grained locks ya CAS-based primitives. ConcurrentHashMap over synchronized HashMap. Virtual threads agar Java 21 use kar rahe hain to scale much better blocking IO ke saath.", durationSec: 18 },
  { speaker: "recruiter", text: "Bahut accha. Ab data layer — PostgreSQL pe ek slow query agar mil gayi, debug kaise karoge?", durationSec: 6 },
  { speaker: "candidate", text: "EXPLAIN ANALYZE first to see actual plan. Sequential scan vs index scan check karoonga. pg_stat_statements se top queries dekho. Index suggest karne se pehle cardinality dekho — low-cardinality index uselesss hota hai. Composite indexes for multi-column where clauses, aur covering indexes for index-only scans agar query selective hai.", durationSec: 19 },
  { speaker: "recruiter", text: "Solid. Ek system design — design a notification fan-out service jo 1 million users ko 1 minute mein notify kar sake.", durationSec: 7 },
  { speaker: "candidate", text: "Mujhe pehle requirements clarify karne do — push, SMS, email all three? Aur user preferences honge?", durationSec: 5 },
  { speaker: "recruiter", text: "Push primary, with email fallback. User preferences yes.", durationSec: 4 },
  { speaker: "candidate", text: "Theek hai. Producer side — ek API jo notification request leta hai, validate karta hai, aur Kafka topic pe push karta hai partitioned by user_id. Consumer workers — auto-scaled, partition-aware, batch size around 1000. Each worker checks user preference cache (Redis), then routes to FCM/APNS for push or SES for email. Rate limit per provider — for FCM say 100k/sec — token bucket implement karenge. Monitoring — delivery rate, p95 latency from queue-to-delivered, error budget per provider.", durationSec: 31 },
  { speaker: "recruiter", text: "Great breakdown. Last question — aapke koi questions hain technical scope ke baare mein?", durationSec: 5 },
  { speaker: "candidate", text: "Haan ek — current team kis stack pe hai exactly? Aur on-call rotation kaise hai?", durationSec: 6 },
  { speaker: "recruiter", text: "Java 17 + Spring Boot 3, PostgreSQL 15, Kafka, AWS EKS. On-call ek week per 6 weeks roughly, primary plus backup pair ka rotation.", durationSec: 9 },
  { speaker: "candidate", text: "Theek hai. That sounds reasonable.", durationSec: 3 },
  { speaker: "recruiter", text: "Thanks Vihaan, bahut accha conversation tha. Aapka recruiter follow-up karega within 2 working days with full process. Take care!", durationSec: 8 },
  { speaker: "candidate", text: "Thank you Rohan. Bye bye.", durationSec: 3 },
];

const INTEREST_GAUGE_DIALOGUE: DialogueTurn[] = [
  { speaker: "recruiter", text: "Hi Aditya, this is Maya from RecruitAssist. We last spoke 2 months back about senior backend role. Just checking in — aap still actively looking ho?", durationSec: 8 },
  { speaker: "candidate", text: "Haan Maya, hello. Hmm, abhi situation thoda different hai — current company mein internal mobility opportunity aaya hai, so seriously considering that.", durationSec: 11 },
  { speaker: "recruiter", text: "Got it — that's good news. Aap chahte ho ki main aapko parked rakhoon for 60-90 days?", durationSec: 6 },
  { speaker: "candidate", text: "Haan exactly. 90 days ka parked status sahi rahega. Internal move agar fall through ho gayi to definitely main reach out karoonga.", durationSec: 9 },
  { speaker: "recruiter", text: "Perfect. CTC ya designation mein recent koi changes?", durationSec: 4 },
  { speaker: "candidate", text: "Annual cycle pichle month hua tha — 18% hike mila, so ab 36 LPA fixed hoon. Designation Tech Lead now.", durationSec: 8 },
  { speaker: "recruiter", text: "Update karti hoon profile mein. Notice period?", durationSec: 4 },
  { speaker: "candidate", text: "Same — 60 days, slightly negotiable.", durationSec: 4 },
  { speaker: "recruiter", text: "Bahut accha. Recruiter aapko 90 days mein wapas reach karega with relevant senior openings. Anything specific aap dekh rahe ho?", durationSec: 8 },
  { speaker: "candidate", text: "Specifically platform engineering ya distributed systems roles. Architecture-leaning, not pure IC anymore.", durationSec: 7 },
  { speaker: "recruiter", text: "Note kiya — Solutions Architect ya Senior Tech Lead level roles. Thanks Aditya, take care!", durationSec: 7 },
  { speaker: "candidate", text: "Thanks Maya, dhanyavaad.", durationSec: 3 },
];

const NOTICE_COMP_DIALOGUE: DialogueTurn[] = [
  { speaker: "recruiter", text: "Hi Riya, this is Kabir from RecruitAssist. Quick 4-minute call to make sure we're aligned on compensation and notice period before recruiter walks you through the role. Is now okay?", durationSec: 10 },
  { speaker: "candidate", text: "Haan Kabir, go ahead.", durationSec: 3 },
  { speaker: "recruiter", text: "The role's fixed CTC range is 22 to 38 LPA, plus standard variable. Yeh aapke expectation se aligned hai?", durationSec: 7 },
  { speaker: "candidate", text: "Hmm, mainly aligned hai but main 35 plus expect kar rahi thi. Variable kitna hota hai usually?", durationSec: 7 },
  { speaker: "recruiter", text: "Variable typically 12-15% of fixed. So 38 fixed ke saath roughly 4-5 LPA variable.", durationSec: 7 },
  { speaker: "candidate", text: "Got it. Theek hai, range is aligned.", durationSec: 4 },
  { speaker: "recruiter", text: "Perfect. Aapka current CTC aur expected? Just to confirm what's on file.", durationSec: 5 },
  { speaker: "candidate", text: "Currently 24 fixed, 28 total. Expected 35 fixed minimum.", durationSec: 6 },
  { speaker: "recruiter", text: "Note kiya. Notice period — joining ideally 45 days mein, kya aapka match karta hai?", durationSec: 7 },
  { speaker: "candidate", text: "Mera notice 90 days hai officially. Buyout option hai but probably 60 days realistic. 45 might be tough.", durationSec: 9 },
  { speaker: "recruiter", text: "Theek hai. Recruiter aapse buyout aur reduced notice par baat karega — let's see if 60 days workable hai.", durationSec: 8 },
  { speaker: "candidate", text: "Haan, ek ya doh weeks tak vacation pending hai jo I can leverage to reduce notice. Discuss kar lenge.", durationSec: 7 },
  { speaker: "recruiter", text: "Perfect. Recruiter Anjali aapko full JD aur next steps share karegi. Anything else?", durationSec: 7 },
  { speaker: "candidate", text: "Nahi, all good. Thank you Kabir!", durationSec: 4 },
  { speaker: "recruiter", text: "Aapka shukriya Riya. Take care!", durationSec: 3 },
];

const SHORT_DIALOGUE: DialogueTurn[] = [
  { speaker: "recruiter", text: "Hi Krishna, RecruitAssist se Anjali bol rahi hoon. Ek senior backend opportunity ke baare mein quick chat?", durationSec: 6 },
  { speaker: "candidate", text: "Haan Anjali, just 5 minutes hain mere paas right now.", durationSec: 4 },
  { speaker: "recruiter", text: "Theek hai. Currently aap kis company mein ho?", durationSec: 3 },
  { speaker: "candidate", text: "Microsoft India, Senior SDE level 62.", durationSec: 4 },
  { speaker: "recruiter", text: "Wow strong background. Kya aap actively looking ho ya passive?", durationSec: 5 },
  { speaker: "candidate", text: "Currently passive — comfortable hoon yahaan. Lekin agar GCC role with strong tech depth aaye to definitely interested.", durationSec: 9 },
  { speaker: "recruiter", text: "Got it. Recruiter aapko detailed JD shoot karega — agar fit lage to follow-up. Sounds good?", durationSec: 7 },
  { speaker: "candidate", text: "Haan that works. JD please email pe bhejna.", durationSec: 4 },
  { speaker: "recruiter", text: "Bilkul. Email jaayegi aaj shaam tak. Thanks Krishna!", durationSec: 5 },
  { speaker: "candidate", text: "Thank you, bye!", durationSec: 2 },
];

export const HINGLISH_DIALOGUES: DialogueTurn[][] = [
  GENERAL_SCREEN_DIALOGUE,
  TECHNICAL_SCREEN_DIALOGUE,
  INTEREST_GAUGE_DIALOGUE,
  NOTICE_COMP_DIALOGUE,
  SHORT_DIALOGUE,
];

export const HINGLISH_PROSPECT_SUMMARIES = [
  "Candidate confirmed actively looking. Razorpay backend, 32 LPA total, 60d notice (negotiable). Open to Bengaluru-Pune-Hyderabad. Strong fintech fit. Send full JD.",
  "Aligned on CTC 35-40 fixed; notice 90d but 60d negotiable with buyout. Asked detailed about interview rounds — clearly evaluating multiple options. Move fast.",
  "Currently passive — happy at Microsoft India L62. Will review JD if strong tech depth. Treat as warm-only; no pressure expected.",
  "Notice 60d officially, willing to use leave to compress to 45d. CTC ask 40+ fixed reasonable. L1 ready next week.",
  "Parked for 90 days — internal mobility move pending at current company. Will re-engage if internal fall-through. Updated CTC to 36 LPA.",
  "Borderline experience match — 4 yrs vs 5 yrs minimum. Strong on Spring Boot but light on system design depth. Recommend technical screen first.",
  "Not interested in current openings — wants architecture role only. Refer to senior_technical pool. Updated profile preferences.",
  "Voicemail; left detailed message. Follow up via WhatsApp. Previous calls suggest evening preferred.",
  "Strong technical depth on JVM concurrency. Some hesitation on PostgreSQL deep-dive. Greenlight for L1; flag DB depth for L2 panel.",
  "Compensation gap of 8 LPA — candidate at 28 fixed, demand band 35-50. Recruiter to evaluate stretch budget or move to lower-tier demand.",
];

export const HINGLISH_VOICEMAIL_LINES = [
  "Hi, RecruitAssist se Asha bol rahi hoon. Senior engineering opportunity ke baare mein call kiya tha. Aap free ho to call back kijiye, dhanyavaad.",
  "Hello, Maya from RecruitAssist. Pichle baat hue 2 months ho gaye — ek check-in call tha. Convenient time pe wapas call kar dijiye.",
  "Hi Riya, Kabir from RecruitAssist. CTC aur notice par 4-minute alignment call hai. Available ho to please call back.",
];

export const HINGLISH_CALL_HEADLINES = [
  "Strong fit — Java/Spring Boot + Kafka, 60d notice negotiable. Recruiter to send JD and schedule L1 within 48h.",
  "Technical depth solid on concurrency + DB. Light on system design specifics. Greenlight for L1 with system design probe.",
  "Aligned on CTC and notice. Candidate evaluating 2 other offers — recommend fast-track to L1 within this week.",
  "Compensation gap; candidate firm at 40 fixed minimum. Demand band caps at 35. Recruiter to either escalate budget or move to senior_technical pool.",
  "Parked 90 days — internal mobility pending. Re-engage if move falls through.",
  "Not interested in current opening — wants pure architecture role. Profile updated for senior architect openings.",
];
