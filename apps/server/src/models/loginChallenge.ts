import { Schema, model } from "mongoose";

/**
 * The state between the password and the second factor. It is not a session: it proves nothing but "this person just
 * gave the right password", lives five minutes, can be tried a few times, and is deleted on success.
 */
const loginChallengeSchema = new Schema({
  // SHA-256 of the token the client holds.
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const LoginChallengeModel = model("LoginChallenge", loginChallengeSchema);
