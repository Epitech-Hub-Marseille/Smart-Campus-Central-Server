import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Role } from "@/lib/types";
import { useAuth } from "./AuthContext";

/** Requires a signed-in user, and optionally one of `roles`. */
export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // An administrator without a second factor gets nothing but the page to set it up: the server refuses the rest anyway.
  if (user.twoFactor.required && !user.twoFactor.enabled && location.pathname !== "/security") return <Navigate to="/security" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}
