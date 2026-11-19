import { roleOf, type Group, type UserDoc } from "./user.js";

export interface UserLike {
  _id: unknown;
  email?: string | null;
  name: string;
  groups: Group[];
  cardUid?: string | null;
  department?: string | null;
  service?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  disabled: boolean;
  passwordHash?: string | null;
  twoFactor?: { enabled?: boolean | null } | null;
  createdAt?: Date;
}

/** Full record for the staff directory (admin/operator views). */
export const userDto = (u: UserLike | UserDoc) => ({
  id: String(u._id),
  email: u.email ?? null,
  name: u.name,
  groups: [...u.groups] as Group[],
  role: roleOf(u.groups as Group[]),
  cardUid: u.cardUid ?? null,
  department: u.department ?? "",
  service: u.service ?? null,
  jobTitle: u.jobTitle ?? "",
  phone: u.phone ?? "",
  disabled: u.disabled,
  hasPassword: Boolean(u.passwordHash),
  twoFactor: Boolean(u.twoFactor?.enabled),
  createdAt: u.createdAt,
});
