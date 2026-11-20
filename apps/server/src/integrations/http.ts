import { PortalError } from "./types.js";

const TIMEOUT_MS = 20_000;
/** A calendar export is a few hundred kilobytes; this is far above that and far below what could hurt the server. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Downloads a text file from a portal. HTTPS only, no redirects (a redirect could leave the host the plugin allowed), a time
 * limit and a size limit. Errors never contain the URL: it often holds the secret that gives access.
 */
export async function fetchText(url: string, doFetch: typeof fetch): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new PortalError("The portal address must use https");
  let res: Response;
  try {
    res = await doFetch(target, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "text/calendar, text/plain, */*" } });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new PortalError(timedOut ? "The portal did not answer in time" : "The portal could not be reached");
  }
  if (res.status >= 300 && res.status < 400) throw new PortalError("The portal redirected the request, which is not followed");
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new PortalError(`The portal refused the request (${res.status}): check the address and its token`);
  if (!res.ok) throw new PortalError(`The portal answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new PortalError("The portal's file is too large");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new PortalError("The portal's file is too large");
  return body.toString("utf8");
}
