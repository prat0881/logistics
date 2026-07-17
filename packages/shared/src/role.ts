export const Role = {
  EXECUTIVE: "EXECUTIVE",
  MANAGER: "MANAGER",
  ADMINISTRATOR: "ADMINISTRATOR",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ROLES: Role[] = [Role.EXECUTIVE, Role.MANAGER, Role.ADMINISTRATOR];
