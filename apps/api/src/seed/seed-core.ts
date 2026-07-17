import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

export interface SeedUser {
  name: string;
  email: string;
  password: string;
  role: Role;
}

export function seedUsersFromEnv(env: NodeJS.ProcessEnv = process.env): SeedUser[] {
  return [
    {
      name: "Administrator",
      email: env.SEED_ADMIN_EMAIL ?? "admin@svyft.local",
      password: env.SEED_ADMIN_PASSWORD ?? "admin-dev-password",
      role: Role.ADMINISTRATOR,
    },
    {
      name: "Manager",
      email: env.SEED_MANAGER_EMAIL ?? "manager@svyft.local",
      password: env.SEED_MANAGER_PASSWORD ?? "manager-dev-password",
      role: Role.MANAGER,
    },
    {
      name: "Executive",
      email: env.SEED_EXECUTIVE_EMAIL ?? "exec@svyft.local",
      password: env.SEED_EXECUTIVE_PASSWORD ?? "exec-dev-password",
      role: Role.EXECUTIVE,
    },
  ];
}

export async function runSeed(
  prisma: PrismaClient,
  users: SeedUser[] = seedUsersFromEnv(),
): Promise<void> {
  const cost = Number(process.env.BCRYPT_COST ?? 10);
  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      continue; // idempotent: never overwrite an existing user
    }
    await prisma.user.create({
      data: {
        name: u.name,
        email: u.email,
        passwordHash: await bcrypt.hash(u.password, cost),
        role: u.role,
      },
    });
  }
}
