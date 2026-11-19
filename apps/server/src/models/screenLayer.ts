import { Schema, model } from "mongoose";

export const SCREEN_SCOPES = ["default", "group", "device"] as const;
export type ScreenScope = (typeof SCREEN_SCOPES)[number];

/**
 * What one level of the hierarchy says about Faculty screens. `default` applies to every screen, `group` to the
 * members of a group, `device` to one screen. The most specific level wins:
 * - `config` is a sparse patch (see `facultyConfigPatch`), merged field by field;
 * - `scenes` is a whole playlist. `null` means "use the one of the level above", an array replaces it.
 */
const screenLayerSchema = new Schema(
  {
    scope: { type: String, enum: SCREEN_SCOPES, required: true },
    // "-" for the default layer, a groupId for a group, a deviceId for a device.
    key: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    scenes: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false },
);

screenLayerSchema.index({ scope: 1, key: 1 }, { unique: true });

export const ScreenLayerModel = model("ScreenLayer", screenLayerSchema);
