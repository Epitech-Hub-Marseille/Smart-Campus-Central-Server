import { Link, Navigate, useParams } from "react-router-dom";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { useOptionalDeviceStatus } from "@/lib/DeviceStatus";
import { SECTIONS } from "@/lib/sections";

/** Hub page of a section: one box per feature, so the rail only needs one entry for all of them. */
export function SectionPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const status = useOptionalDeviceStatus();
  const section = SECTIONS.find((s) => s.id === id);
  if (!section || section.items.length === 0 || (section.managerOnly && !canEditCampus(user))) return <Navigate to="/" replace />;
  const waiting = status?.requests.length ?? 0;

  return (
    <div>
      <PageHeader title={section.label} description={section.summary} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {section.items.map(({ to, label, icon: Icon, description }) => (
          <Link key={to} to={to} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <Card className="h-full gap-3 transition-colors hover:border-primary/40">
              <CardContent className="flex items-start gap-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-primary">
                  <Icon className="size-5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[15px] font-semibold">
                    {label}
                    {to === "/devices" && waiting > 0 && (
                      <span className="rounded-full bg-primary px-1.5 text-[11px] leading-4 font-medium text-primary-foreground">{waiting} waiting</span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
