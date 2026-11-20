import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";

const POLL_MS = 30_000;

interface UnreadValue {
  unread: number;
  /** Ask the server again now (after reading or sending something). */
  refresh: () => void;
}
const UnreadContext = createContext<UnreadValue>({ unread: 0, refresh: () => {} });

/**
 * How many messages are waiting for this person. The console channel is for administrators only, and messages are for
 * everyone, so this polls: a count every 30 s is cheap, and it pauses while the tab is hidden.
 */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState(0);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api<{ unread: number }>("/messages/unread-count")
        .then((r) => alive && setUnread(r.unread))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [nonce]);

  const value = useMemo(() => ({ unread, refresh }), [unread, refresh]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export const useUnread = () => useContext(UnreadContext);
