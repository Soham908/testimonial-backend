import bcrypt from "bcryptjs";

/**
 * Phase A test tooling only (see backend-plan.html #identity) — plain
 * username/password against the 5 seeded distributors from prisma/seed.ts.
 * Replaced wholesale by invite_token exchange in Phase B; nothing downstream
 * of the auth middleware changes when that happens.
 */
type SeedAccount = {
  username: string;
  passwordHash: string;
  invite_token: string;
};

function account(username: string, password: string, invite_token: string): SeedAccount {
  return { username, passwordHash: bcrypt.hashSync(password, 10), invite_token };
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  account("ramesh", "ramesh123", "invite-ramesh-traders"),
  account("suresh", "suresh123", "invite-suresh-electronics"),
  account("patel", "patel123", "invite-patel-home-appliances"),
  account("sharma", "sharma123", "invite-sharma-cooling"),
  account("kumar", "kumar123", "invite-kumar-sales"),
];
