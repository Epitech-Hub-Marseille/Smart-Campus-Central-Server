export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** A stable word the console can act on (for example to open the two-factor setup), unlike the message. */
    public code?: string,
  ) {
    super(message);
  }
}
