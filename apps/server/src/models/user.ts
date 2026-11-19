import { AVAILABILITIES, SERVICES } from "@smartcampus/protocol";
import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * Administrative groups. A person can belong to several: a student can also be an operator.
 * Not to be confused with device groups, which are free-text labels on devices.
 */
export const GROUPS = ["admin", "operator", "student"] as const;
export type Group = (typeof GROUPS)[number];

/** Groups whose members may open the maintenance menu on a reader and use the console. */
export const PRIVILEGED_GROUPS: readonly Group[] = ["admin", "operator"];

/**
 * Console permission level. It is never stored: it is the highest privilege among the groups, so
 * the groups stay the only source of truth.
 */
export const ROLES = ["admin", "operator", "staff"] as const;
export type Role = (typeof ROLES)[number];

export function roleOf(groups: readonly Group[]): Role {
  if (groups.includes("admin")) return "admin";
  if (groups.includes("operator")) return "operator";
  return "staff";
}

/** Replaces the admin/operator part of `groups` with `role`, keeping the rest (a student stays a student). */
export function withRole(groups: readonly Group[], role: Role): Group[] {
  const kept = groups.filter((g) => !PRIVILEGED_GROUPS.includes(g));
  return role === "staff" ? kept : [role, ...kept];
}

export const isPrivileged = (groups: readonly Group[]) => groups.some((g) => PRIVILEGED_GROUPS.includes(g));

/** Ways a user can sign in. `local` = email + password, others are external identity providers. */
export const PROVIDERS = [
  "local",
  "azure"
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

const identitySchema = new Schema(
  {
    provider: { type: String, enum: PROVIDERS, required: true },
    // Stable id from the provider (for Azure: the `oid` or `sub` claim), never the email.
    subject: { type: String, required: true },
  },
  { _id: false },
);

/** What a person shows on the Faculty screens. `until` makes it lapse by itself (back at 14:00). */
const availabilitySchema = new Schema(
  {
    status: { type: String, enum: AVAILABILITIES, default: "available", required: true },
    note: { type: String, trim: true, default: "" },
    until: { type: Date },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/**
 * Two-factor authentication (TOTP). The secret is stored encrypted; recovery codes only as hashes. `lastUsedStep` makes a
 * code single-use, and `failures`/`lockedUntil` slow down guessing.
 */
const twoFactorSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    enabledAt: { type: Date },
    secret: { type: String },
    // A secret being set up: it only replaces the real one once the person proved they can produce a code from it.
    pendingSecret: { type: String },
    lastUsedStep: { type: Number, default: -1 },
    recoveryHashes: { type: [String], default: [] },
    failures: { type: Number, default: 0 },
    lockedUntil: { type: Date },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    // Optional: a student who only has a card has no console login. The unique index ignores missing emails.
    email: { type: String, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    groups: { type: [{ type: String, enum: GROUPS }], default: [] },
    // Serial number of the person's NFC card, normalised by `normalizeCardUid` (upper-case hex).
    cardUid: { type: String },
    // Absent for users that only sign in through SSO.
    passwordHash: { type: String },
    identities: { type: [identitySchema], default: [] },
    department: { type: String, trim: true },
    // Set for people who appear in the Faculty availability list. Absent: not listed.
    service: { type: String, enum: SERVICES },
    availability: { type: availabilitySchema },
    jobTitle: { type: String, trim: true },
    phone: { type: String, trim: true },
    disabled: { type: Boolean, default: false },
    twoFactor: { type: twoFactorSchema },
  },
  { timestamps: true },
);

// Partial rather than sparse: an explicit `null` or a missing field must not count as a duplicate.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ cardUid: 1 }, { unique: true, partialFilterExpression: { cardUid: { $type: "string" } } });
userSchema.index(
  { "identities.provider": 1, "identities.subject": 1 },
  { unique: true, partialFilterExpression: { "identities.0": { $exists: true } } },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model("User", userSchema);

/** What the API exposes to clients. */
export interface PublicUser {
  id: string;
  email: string | null;
  name: string;
  role: Role;
  groups: Group[];
  /** Whether it is on, and whether this person must have it (the console sends admins to set it up). */
  twoFactor: { enabled: boolean; required: boolean };
}

export function toPublicUser(user: UserDoc): PublicUser {
  const groups = user.groups as Group[];
  const role = roleOf(groups);
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name,
    role,
    groups,
    twoFactor: { enabled: Boolean(user.twoFactor?.enabled), required: role === "admin" && twoFactorRequiredForAdmins() },
  };
}

// Read when asked, not at import, so the setting can be changed in tests and the model does not import the config twice.
import { config } from "../config.js";
const twoFactorRequiredForAdmins = () => config.REQUIRE_ADMIN_2FA;
