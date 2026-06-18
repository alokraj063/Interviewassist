// Read-only frozen version snapshot at /rubrics/:id/versions/:version. Shows
// the immutable criteria exactly as published — scores pin to this.
import { Link, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Loader2, Lock } from "lucide-react";
import { normalizedWeights, PURPOSE_LABELS, useRubricVersion } from "@/hooks/useRubrics";

export default function RubricVersionView() {
  const { id, version } = useParams<{ id: string; version: string }>();
  const { data, isLoading, isError, error } = useRubricVersion(id, version);

  if (isLoading) {
    return (
      <div className="p-10 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading version…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10 space-y-3">
        <div className="text-sm text-destructive">{error instanceof Error ? error.message : "Version not found."}</div>
        <Button size="sm" variant="ghost" asChild>
          <Link to={`/rubrics/${id}`}>Back to rubric</Link>
        </Button>
      </div>
    );
  }

  const v = data.version;
  const norm = normalizedWeights(v.criteria);

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Rubrics", href: "/rubrics" }, { label: v.name, href: `/rubrics/${id}` }, { label: `v${v.version}` }]}
        title={
          <span className="flex items-center gap-2">
            <Link to={`/rubrics/${id}`} className="text-muted-foreground hover:text-foreground" aria-label="Back to rubric">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            {v.name} — v{v.version}
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              <Lock className="w-3 h-3 mr-1" /> Immutable snapshot
            </span>
            <span>{PURPOSE_LABELS[v.purpose]}</span>
            <span className="text-xs text-muted-foreground">Published {new Date(v.publishedAt).toLocaleString()}</span>
            {v.publishedByName && <span className="text-xs text-muted-foreground">by {v.publishedByName}</span>}
          </span>
        }
      />
      <div className="p-6 space-y-4">
        {v.changeNote && (
          <Card title="Change note">
            <div className="p-4 text-sm text-muted-foreground">{v.changeNote}</div>
          </Card>
        )}
        <Card title={`Criteria (${v.criteria.length})`}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Kind</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Normalized</th>
                <th>Bands (fail / pass / excellent)</th>
                <th className="text-right">Min evidence</th>
              </tr>
            </thead>
            <tbody>
              {v.criteria.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="text-sm font-medium">{c.name}</div>
                    {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
                  </td>
                  <td className="text-sm capitalize">{c.kind.replace(/_/g, " ")}</td>
                  <td className="text-right tabular-nums">{c.weight}</td>
                  <td className="text-right tabular-nums">{(norm.get(c.id) ?? 0).toFixed(1)}%</td>
                  <td className="text-sm tabular-nums">
                    {c.bandThresholds.fail} / {c.bandThresholds.pass} / {c.bandThresholds.excellent}
                  </td>
                  <td className="text-right tabular-nums">{c.minEvidenceQuotes ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
