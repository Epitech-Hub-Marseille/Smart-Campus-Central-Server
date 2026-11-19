import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { ApiError } from "@/lib/api";
import { Wordmark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginPage() {
  const { user, loading, providers, sessionExpired, login, completeTwoFactor } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once the password was right and a second factor is needed.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const next = await login(email, password);
      if (next) setChallenge(next.challenge);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCode(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      await completeTwoFactor(challenge, useRecovery ? { recoveryCode: code } : { code });
    } catch (err) {
      // An expired sign-in starts again from the password; a wrong code stays here to be tried again.
      if (err instanceof ApiError && err.code === "challenge_expired") setChallenge(null);
      setCode("");
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 justify-center [&_img]:size-9 [&>span:last-child]:text-xl" />
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{challenge ? "Two-factor authentication" : "Sign in"}</CardTitle>
            <CardDescription>{challenge ? (useRecovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app.") : "Use your campus account credentials."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {challenge ? (
              <form onSubmit={onCode} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="code">{useRecovery ? "Recovery code" : "Code"}</Label>
                  <Input
                    id="code"
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={useRecovery ? "text" : "numeric"}
                    maxLength={useRecovery ? 12 : 7}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="font-mono tracking-widest"
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={busy}>
                  {busy ? "Checking…" : "Verify"}
                </Button>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <button type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => (setUseRecovery(!useRecovery), setCode(""), setError(null))}>
                    {useRecovery ? "Use the authenticator app" : "Use a recovery code"}
                  </button>
                  <button type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => (setChallenge(null), setCode(""), setError(null))}>
                    Back
                  </button>
                </div>
              </form>
            ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link to="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Forgot password?
                  </Link>
                </div>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              {sessionExpired && !error && (
                <p role="status" className="text-sm text-muted-foreground">
                  Your session expired. Please sign in again.
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
            )}

            {!challenge && providers.azure && (
              <>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button variant="outline" asChild>
                  <a href="/api/auth/azure/login">Sign in with Microsoft</a>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
