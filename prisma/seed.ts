import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Local dev databases don't survive a laptop switch, but the seed script
  // might still be re-run against a database that already has this data
  // (e.g. re-running after an error) — upsert everything below, keyed on
  // each model's real unique constraint, so the whole script is safe to run
  // against an empty table or an already-seeded one.
  const ifb = await prisma.client.upsert({
    where: { name: "IFB Appliances" },
    update: {},
    create: {
      name: "IFB Appliances",
      branding_config: {
        logo_url: "https://assets.example.com/ifb/logo.png",
        primary_color: "#C0392B",
        // Shared rough test template for now — both clients point at the same
        // real nexrender-cloud template until distinct branded ones exist.
        nexrender_template: "01KY9MN1XA629BAZYSV18G69HQ",
      },
    },
  });

  const voltas = await prisma.client.upsert({
    where: { name: "Voltas" },
    update: {},
    create: {
      name: "Voltas",
      branding_config: {
        logo_url: "https://assets.example.com/voltas/logo.png",
        primary_color: "#1F6F54",
        // Same shared rough test template — see note on IFB above.
        nexrender_template: "01KY9MN1XA629BAZYSV18G69HQ",
      },
    },
  });

  // Third dummy client, holding only self-registered internal test
  // participants (src/routes/register.ts, gated behind
  // ENABLE_SELF_REGISTRATION) - kept separate from IFB (which will become a
  // real client) and Voltas so self-registered test rows can never end up
  // mixed into either one, now or once real IFB provisioning exists.
  const zeist = await prisma.client.upsert({
    where: { name: "Zeist" },
    update: {},
    create: {
      name: "Zeist",
      branding_config: {
        logo_url: "https://assets.example.com/zeist/logo.png",
        primary_color: "#333333",
        // Same shared rough test template — see note on IFB above.
        nexrender_template: "01KY9MN1XA629BAZYSV18G69HQ",
      },
    },
  });

  // business/city/years_as_distributor are internal-test-phase-only fields
  // (frontend header/profile screens show them, nothing real to source them
  // from yet - see prisma/schema.prisma). Values here are deliberately
  // test-looking, not invented company data.
  const distributors = [
    {
      client_id: ifb.id,
      name: "Ramesh Traders",
      phone: "+91-9800000001",
      invite_token: "invite-ramesh-traders",
      language_pref: "en",
      business: "Test Business — Ramesh",
      city: "Test City 1",
      years_as_distributor: 3,
    },
    {
      client_id: ifb.id,
      name: "Suresh Electronics",
      phone: "+91-9800000002",
      invite_token: "invite-suresh-electronics",
      language_pref: "hi",
      business: "Test Business — Suresh",
      city: "Test City 2",
      years_as_distributor: 5,
    },
    {
      client_id: ifb.id,
      name: "Patel Home Appliances",
      phone: "+91-9800000003",
      invite_token: "invite-patel-home-appliances",
      language_pref: "en",
      business: "Test Business — Patel",
      city: "Test City 3",
      years_as_distributor: 2,
    },
    {
      client_id: voltas.id,
      name: "Sharma Cooling Solutions",
      phone: "+91-9800000004",
      invite_token: "invite-sharma-cooling",
      language_pref: "hi",
      business: "Test Business — Sharma",
      city: "Test City 4",
      years_as_distributor: 4,
    },
    {
      client_id: voltas.id,
      name: "Kumar Sales Corp",
      phone: "+91-9800000005",
      invite_token: "invite-kumar-sales",
      language_pref: "en",
      business: "Test Business — Kumar",
      city: "Test City 5",
      years_as_distributor: 6,
    },
  ];

  // Full sync on every field, not just "create if missing" - this seed is
  // the single source of truth for these dummy accounts (unlike real
  // distributor data later), so a rerun should bring an already-seeded row
  // back in line with it, e.g. after adding business/city/years_as_distributor
  // to a DB seeded before those columns existed.
  for (const distributor of distributors) {
    await prisma.distributor.upsert({
      where: { invite_token: distributor.invite_token },
      update: distributor,
      create: distributor,
    });
  }

  // Internal-test question set (education theme) — both dummy clients get
  // the same 5 for now, all unbranded. IFB's real 7-question set for the
  // actual engagement is separate, later work; not seeded here.
  //
  const EDUCATION_QUESTIONS: Array<{
    text_en: string;
    text_hi: string;
    text_mr: string;
    talking_points: { en: string[]; hi: string[] | null; mr: string[] | null };
  }> = [
    {
      text_en: "What did your education teach you that you still value today?",
      text_hi: "आपकी पढ़ाई ने आपको क्या सिखाया, जिसे आप आज भी महत्व देते हैं?",
      text_mr: "तुमच्या शिक्षणाने तुम्हाला काय शिकवलं, ज्याला तुम्ही आजही महत्त्व देता?",
      talking_points: {
        en: ["Specific subject or teacher", "A skill you still use", "Why it stayed with you"],
        hi: ["कोई खास विषय या शिक्षक", "अब भी काम आने वाला हुनर", "यह याद क्यों रह गया"],
        mr: ["एखादा खास विषय किंवा शिक्षक", "अजूनही उपयोगी पडणारं कौशल्य", "हे लक्षात का राहिलं"],
      },
    },
    {
      text_en: "What's your best education memory, and why?",
      text_hi: "आपकी पढ़ाई की सबसे अच्छी याद क्या है, और क्यों?",
      text_mr: "तुमच्या शिक्षणातील सर्वात चांगली आठवण कोणती, आणि का?",
      talking_points: {
        en: ["A specific moment", "Who was there", "Why it stands out"],
        hi: ["कोई खास पल", "उस वक्त कौन था", "यह खास क्यों है"],
        mr: ["एखादा खास क्षण", "त्यावेळी कोण होतं", "हे खास का वाटतं"],
      },
    },
    {
      text_en: "What do you wish your education had taught you?",
      text_hi: "आप चाहते थे कि पढ़ाई में आपको और क्या सिखाया जाता?",
      text_mr: "तुमच्या शिक्षणात तुम्हाला आणखी काय शिकवायला हवं होतं?",
      talking_points: {
        en: ["A missing skill or subject", "Learned the hard way later", "What would have helped"],
        hi: ["कोई छूटा हुआ विषय या हुनर", "बाद में मुश्किल से सीखा", "क्या चीज़ मदद करती"],
        mr: ["न शिकवलेला विषय किंवा कौशल्य", "नंतर कठीण मार्गाने शिकलात", "काय उपयोगी ठरलं असतं"],
      },
    },
    {
      text_en: "What's better about education today, and what's worse?",
      text_hi: "आज की पढ़ाई में क्या बेहतर है और क्या खराब?",
      text_mr: "आजच्या शिक्षणात काय चांगलं आहे आणि काय वाईट?",
      talking_points: {
        en: ["What's genuinely improved", "What's worse or lost", "A real example"],
        hi: ["सच में क्या बेहतर हुआ", "क्या बिगड़ा या खो गया", "एक असली उदाहरण"],
        mr: ["खरंच काय सुधारलं आहे", "काय बिघडलं किंवा हरवलं", "एक खरं उदाहरण"],
      },
    },
    {
      text_en: "If you could change three things about education, what would they be?",
      text_hi: "अगर आप पढ़ाई में तीन चीज़ें बदल सकते, तो क्या बदलते?",
      text_mr: "तुम्हाला शिक्षणात तीन गोष्टी बदलता आल्या, तर काय बदलाल?",
      talking_points: {
        en: ["Be specific, not general", "What helps students most", "Small changes count too"],
        hi: ["सामान्य नहीं, खास बताएं", "छात्रों की सबसे ज़्यादा मदद", "छोटे बदलाव भी मायने रखते हैं"],
        mr: ["सर्वसाधारण नाही, नेमकं सांगा", "विद्यार्थ्यांना सर्वात जास्त उपयोगी", "छोटे बदलही महत्त्वाचे असतात"],
      },
    },
  ];

  // Not yet recorded/uploaded for any language — these are forward
  // references, same as the video_key convention, so rendering will fail
  // loudly (missing S3 object) rather than silently until the audio exists.
  function voKey(clientId: string, lang: "en" | "hi" | "mr", index: number): string {
    return `static/question-vo/${clientId}/${lang}/${index}.mp3`;
  }

  for (const client of [ifb, voltas, zeist]) {
    for (const [i, q] of EDUCATION_QUESTIONS.entries()) {
      const index = i + 1;
      const data = {
        client_id: client.id,
        index,
        is_branded: false,
        text_en: q.text_en,
        text_hi: q.text_hi,
        text_mr: q.text_mr,
        talking_points: q.talking_points,
        extraction_spec: null,
        vo_key_en: voKey(client.id, "en", index),
        vo_key_hi: voKey(client.id, "hi", index),
        vo_key_mr: voKey(client.id, "mr", index),
      };
      await prisma.question.upsert({
        where: { client_id_index: { client_id: client.id, index } },
        update: data,
        create: data,
      });
    }
  }

  console.log("Seeded 3 clients (IFB, Voltas, Zeist), 5 distributors, and 5 questions per client.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
