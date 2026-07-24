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

  console.log("Seeded 2 clients and 5 distributors.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
