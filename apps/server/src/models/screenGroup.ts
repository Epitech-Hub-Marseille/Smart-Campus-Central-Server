import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * A group of Faculty screens that share settings and, optionally, a playlist. A screen belongs to at most one
 * group (the server keeps it that way), so which settings apply to it is never ambiguous.
 */
const screenGroupSchema = new Schema(
  {
    groupId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, default: "" },
    // Device ids of Faculty displays.
    members: { type: [String], default: [] },
  },
  { timestamps: true },
);

screenGroupSchema.index({ members: 1 });

export type ScreenGroupDoc = InferSchemaType<typeof screenGroupSchema> & { id: string };
export const ScreenGroupModel = model("ScreenGroup", screenGroupSchema);
