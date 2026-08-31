import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ifb = await prisma.client.create({
    data: {
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

  const voltas = await prisma.client.create({
    data: {
      name: "Voltas",
      branding_config: {
        logo_url: "https://assets.example.com/voltas/logo.png",
        primary_color: "#1F6F54",
        // Same shared rough test template — see note on IFB above.
        nexrender_template: "01KY9MN1XA629BAZYSV18G69HQ",
      },
    },
  });

  await prisma.distributor.createMany({
    data: [
      {
        client_id: ifb.id,
        name: "Ramesh Traders",
        phone: "+91-9800000001",
        invite_token: "invite-ramesh-traders",
        language_pref: "en",
      },
      {
        client_id: ifb.id,
        name: "Suresh Electronics",
        phone: "+91-9800000002",
        invite_token: "invite-suresh-electronics",
        language_pref: "hi",
      },
      {
        client_id: ifb.id,
        name: "Patel Home Appliances",
        phone: "+91-9800000003",
        invite_token: "invite-patel-home-appliances",
        language_pref: "en",
      },
      {
        client_id: voltas.id,
        name: "Sharma Cooling Solutions",
        phone: "+91-9800000004",
        invite_token: "invite-sharma-cooling",
        language_pref: "hi",
      },
      {
        client_id: voltas.id,
        name: "Kumar Sales Corp",
        phone: "+91-9800000005",
        invite_token: "invite-kumar-sales",
        language_pref: "en",
      },
    ],
  });

  // Internal-test question set (education theme) — both dummy clients get
  // the same 5 for now, all unbranded. IFB's real 7-question set for the
  // actual engagement is separate, later work; not seeded here.
  const EDUCATION_QUESTIONS: Array<{ text_en: string; text_hi: string; text_mr: string }> = [
    {
      text_en: "What did your education teach you that you still value today?",
      text_hi: "आपकी पढ़ाई ने आपको क्या सिखाया, जिसे आप आज भी महत्व देते हैं?",
      text_mr: "तुमच्या शिक्षणाने तुम्हाला काय शिकवलं, ज्याला तुम्ही आजही महत्त्व देता?",
    },
    {
      text_en: "What's your best education memory, and why?",
      text_hi: "आपकी पढ़ाई की सबसे अच्छी याद क्या है, और क्यों?",
      text_mr: "तुमच्या शिक्षणातील सर्वात चांगली आठवण कोणती, आणि का?",
    },
    {
      text_en: "What do you wish your education had taught you?",
      text_hi: "आप चाहते थे कि पढ़ाई में आपको और क्या सिखाया जाता?",
      text_mr: "तुमच्या शिक्षणात तुम्हाला आणखी काय शिकवायला हवं होतं?",
    },
    {
      text_en: "What's better about education today, and what's worse?",
      text_hi: "आज की पढ़ाई में क्या बेहतर है और क्या खराब?",
      text_mr: "आजच्या शिक्षणात काय चांगलं आहे आणि काय वाईट?",
    },
    {
      text_en: "If you could change three things about education, what would they be?",
      text_hi: "अगर आप पढ़ाई में तीन चीज़ें बदल सकते, तो क्या बदलते?",
      text_mr: "तुम्हाला शिक्षणात तीन गोष्टी बदलता आल्या, तर काय बदलाल?",
    },
  ];

  // Not yet recorded/uploaded for any language — these are forward
  // references, same as the video_key convention, so rendering will fail
  // loudly (missing S3 object) rather than silently until the audio exists.
  function voKey(clientId: string, lang: "en" | "hi" | "mr", index: number): string {
    return `static/question-vo/${clientId}/${lang}/${index}.mp3`;
  }

  for (const client of [ifb, voltas]) {
    await prisma.question.createMany({
      data: EDUCATION_QUESTIONS.map((q, i) => {
        const index = i + 1;
        return {
          client_id: client.id,
          index,
          is_branded: false,
          ...q,
          vo_key_en: voKey(client.id, "en", index),
          vo_key_hi: voKey(client.id, "hi", index),
          vo_key_mr: voKey(client.id, "mr", index),
        };
      }),
    });
  }

  console.log("Seeded 2 clients, 5 distributors, and 5 questions per client.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
