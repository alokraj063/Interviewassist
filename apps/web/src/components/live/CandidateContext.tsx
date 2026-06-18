// Recruiter Live Call side panel: candidate profile + active demand summary.
// Replaces the contact-center CRM "CustomerContext" card from the
// j2w-contact-flow predecessor. Data comes from
// GET /api/calls/:id/context which joins candidate + demand + client.
import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { Briefcase, IndianRupee, MapPin, Sparkles, User2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface CallContextResponse {
  callId: string;
  candidate: {
    id: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    currentTitle: string | null;
    currentCompany: string | null;
    totalExperienceYears: string | null;
    currentCtcLakhs: string | null;
    expectedCtcLakhs: string | null;
    noticePeriodDays: number | null;
    noticePeriodNegotiable: boolean | null;
    currentLocation: string | null;
    linkedinUrl: string | null;
  } | null;
  demand: {
    id: string;
    title: string | null;
    designation: string | null;
    salaryFrom: string | null;
    salaryTo: string | null;
    experienceMinYears: string | null;
    experienceMaxYears: string | null;
    primaryLocation: string | null;
    isVip: boolean;
    workMode: string | null;
    customer: string | null;
    status: string;
  } | null;
  candidateRefOrPhone: string | null;
}

export function CandidateContext({ callId }: { callId: string | null }) {
  const [data, setData] = useState<CallContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<CallContextResponse>(`/api/calls/${callId}/context`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  return (
    <div className="h-full bg-card border border-border rounded-lg flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wide">Candidate &amp; demand</h2>
        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <User2 className="w-3 h-3" />
          live context
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!callId && (
          <div className="text-xs text-muted-foreground">
            Start a call to load candidate and demand context.
          </div>
        )}
        {callId && loading && (
          <div className="text-xs text-muted-foreground">Loading context…</div>
        )}
        {callId && error && <div className="text-xs text-error">Context error: {error}</div>}
        {callId && data && (
          <>
            <CandidateBlock data={data} />
            <DemandBlock data={data} />
          </>
        )}
      </div>
    </div>
  );
}

function CandidateBlock({ data }: { data: CallContextResponse }) {
  const k = data.candidate;
  if (!k) {
    return (
      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        No candidate linked yet. {data.candidateRefOrPhone ? `Dialing: ${data.candidateRefOrPhone}` : "Add the prospect to link."}
      </div>
    );
  }
  const initials = (k.displayName ?? k.email ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <Avatar initials={initials} size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{k.displayName ?? "(no name)"}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {[k.currentTitle, k.currentCompany].filter(Boolean).join(" @ ") || "title/company unknown"}
          </div>
          {k.linkedinUrl && (
            <a
              href={k.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-primary hover:underline"
            >
              LinkedIn ↗
            </a>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <ContextField label="Total exp" value={fmtYears(k.totalExperienceYears)} />
        <ContextField label="Notice" value={fmtNotice(k.noticePeriodDays, k.noticePeriodNegotiable)} />
        <ContextField label="Current CTC" value={fmtCtc(k.currentCtcLakhs)} />
        <ContextField label="Expected CTC" value={fmtCtc(k.expectedCtcLakhs)} />
        <ContextField label="Location" value={k.currentLocation ?? "—"} className="col-span-2" />
      </div>
    </div>
  );
}

function DemandBlock({ data }: { data: CallContextResponse }) {
  const d = data.demand;
  if (!d) {
    return (
      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        No demand linked. Sourcing context unavailable.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border p-2 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div className="text-sm font-semibold truncate">{d.title ?? "(untitled)"}</div>
            {d.isVip && (
              <span className="pill bg-warning/20 text-warning text-[10px] px-1.5 py-0.5 inline-flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5" /> VIP
              </span>
            )}
          </div>
          {d.customer && (
            <div className="text-[11px] text-muted-foreground truncate">{d.customer}</div>
          )}
          {d.designation && (
            <div className="text-[11px] text-muted-foreground truncate">{d.designation}</div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <ContextField
          label="Exp band"
          value={fmtBand(d.experienceMinYears, d.experienceMaxYears, "yrs")}
        />
        <ContextField
          label="Salary"
          value={fmtBand(d.salaryFrom, d.salaryTo, "L")}
          icon={<IndianRupee className="w-3 h-3" />}
        />
        <ContextField
          label="Location"
          value={d.primaryLocation ?? "—"}
          icon={<MapPin className="w-3 h-3" />}
        />
        <ContextField label="Work mode" value={d.workMode ?? "—"} />
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "pill text-[10px] px-1.5 py-0.5",
            d.status === "active"
              ? "bg-success/15 text-success"
              : d.status === "closed"
                ? "bg-muted text-muted-foreground"
                : "bg-warning/15 text-warning",
          )}
        >
          {d.status}
        </span>
      </div>
    </div>
  );
}

function ContextField({
  label,
  value,
  className,
  icon,
}: {
  label: string;
  value: string;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-md bg-muted/40 px-2 py-1.5", className)}>
      <div className="text-[10px] uppercase text-muted-foreground inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 truncate">{value}</div>
    </div>
  );
}

function fmtYears(v: string | null): string {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `${n} yr${n === 1 ? "" : "s"}`;
}

function fmtNotice(days: number | null, negotiable: boolean | null): string {
  if (days === null || days === undefined) return "—";
  if (days === 0) return "Immediate";
  return `${days}d${negotiable ? " (neg.)" : ""}`;
}

function fmtCtc(v: string | null): string {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return `${n.toFixed(1)} L`;
}

function fmtBand(min: string | null, max: string | null, unit: string): string {
  if (!min && !max) return "—";
  if (min && max) return `${min}–${max} ${unit}`;
  return `${min ?? max} ${unit}`;
}
