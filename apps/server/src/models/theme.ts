import { Schema, model } from "mongoose";

/** A visual theme (see `packages/protocol/src/theme.ts`): tokens every app understands, and CSS for the Faculty screens. */
const themeSchema = new Schema(
  {
    themeId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, default: "" },
    tokens: { type: Schema.Types.Mixed, default: {} },
    css: { type: String, default: "" },
    // Rises with every edit, so a device can tell it has the latest.
    version: { type: Number, default: 1 },
    createdByName: { type: String, required: true },
  },
  { timestamps: true, minimize: false },
);

export const ThemeModel = model("Theme", themeSchema);

/**
 * Which theme applies where. A device uses, in this order: the theme set for it, the theme set for one of its groups (the
 * first in alphabetical order when it is in several, so the answer never depends on luck), the default for its kind of
 * device, and otherwise its own look.
 */
const themeAssignmentSchema = new Schema(
  {
    scope: { type: String, enum: ["default", "group", "device"], required: true },
    // default: the kind of device ("door" or "display"). group: a device group. device: a device id.
    key: { type: String, required: true },
    themeId: { type: String, required: true },
  },
  { timestamps: true },
);

themeAssignmentSchema.index({ scope: 1, key: 1 }, { unique: true });
themeAssignmentSchema.index({ themeId: 1 });

export const ThemeAssignmentModel = model("ThemeAssignment", themeAssignmentSchema);
