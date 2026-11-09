import { Schema, model } from "mongoose";

/**
 * Second step of a real emergency: a single-use token the console gets from the first click and sends
 * with the second. It is bound to the person and to the exact alert, so a stolen or replayed token
 * cannot trigger anything else. Only its hash is stored. The document disappears at `expiresAt`.
 */
const confirmationSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  payloadHash: { type: String, required: true },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const EmergencyConfirmationModel = model("EmergencyConfirmation", confirmationSchema);
