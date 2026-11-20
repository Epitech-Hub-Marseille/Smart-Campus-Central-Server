import { SERVICES } from "@smartcampus/protocol";
import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * One connection to a portal: which plugin, its settings and how it is doing. Secret settings (a link that holds a token) are
 * kept apart, encrypted, and never sent back to the console.
 */
const integrationSchema = new Schema(
  {
    integrationId: { type: String, required: true, unique: true },
    plugin: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    // The settings that are not secret, as the plugin's field keys.
    config: { type: Schema.Types.Mixed, default: {} },
    // The secret settings, each sealed (see lib/secretBox.ts).
    secrets: { type: Schema.Types.Mixed, default: {} },
    // How often it is read, and how many days ahead, counted from the start of today.
    intervalMinutes: { type: Number, default: 15, min: 5, max: 1440 },
    horizonDays: { type: Number, default: 14, min: 1, max: 90 },
    // People an event names who have no account yet: add them (without any way to sign in) so their events carry their name.
    autoRegister: { type: Boolean, default: true },
    // The Faculty service they are listed under; absent: not listed on the screens.
    registerService: { type: String, enum: SERVICES },
    // Room names as the portal writes them that do not match a room by name or code: "Pédagogie 1-8" -> "B2-104".
    roomAliases: { type: Schema.Types.Mixed, default: {} },
    // Places that are not rooms (a video call, "off site"): never matched, never created, never reported as missing.
    ignoredPlaces: { type: [String], default: [] },
    // A place that matches no room gets one, in this building and on this floor, instead of being left out.
    autoCreateRooms: { type: Boolean, default: false },
    autoCreateBuilding: { type: Schema.Types.ObjectId, ref: "Building" },
    autoCreateFloor: { type: Number, default: 0, min: -10, max: 200 },
    lastSyncAt: { type: Date },
    nextSyncAt: { type: Date },
    lastStatus: { type: String, enum: ["never", "ok", "error"], default: "never" },
    lastError: { type: String },
    lastSummary: { type: Schema.Types.Mixed },
    // Claimed while a read is running, so two server processes (or a click and the timer) never read at once.
    lockedUntil: { type: Date },
  },
  { timestamps: true },
);

integrationSchema.index({ enabled: 1, nextSyncAt: 1 });

export type IntegrationDoc = HydratedDocument<InferSchemaType<typeof integrationSchema>>;
export const IntegrationModel = model("Integration", integrationSchema);
