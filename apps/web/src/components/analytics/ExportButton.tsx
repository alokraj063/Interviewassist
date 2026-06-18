// Per-chart "Export CSV" button. POSTs the report's filter envelope to
// /api/analytics/export (idempotency-keyed), then opens the download endpoint
// in a new tab with a ?token= fallback so a plain link works. Disabled with a
// tooltip reason when the caller lacks analytics.export.
import { useState } from "react";
import { Download, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getApiBase, getAccessToken } from "@/lib/api";
import {
  useExportReport,
  type AnalyticsFilters,
  type ReportKey,
} from "@/hooks/useAnalyticsReports";

export function ExportButton({
  reportKey,
  filters,
  canExport,
  disabled,
}: {
  reportKey: ReportKey;
  filters: AnalyticsFilters;
  canExport: boolean;
  disabled?: boolean;
}) {
  const exp = useExportReport();
  const [downloading, setDownloading] = useState(false);

  if (!canExport) {
    return (
      <Button size="sm" variant="outline" disabled title="Requires analytics.export" data-testid="export-disabled">
        <Lock className="mr-1.5 h-3.5 w-3.5" />
        Export CSV
      </Button>
    );
  }

  function run() {
    setDownloading(true);
    exp.mutate(
      { reportKey, filters },
      {
        onSuccess: (res) => {
          const token = getAccessToken();
          const url = `${getApiBase()}/api/analytics/export/${res.jobId}/download${
            token ? `?token=${encodeURIComponent(token)}` : ""
          }`;
          window.open(url, "_blank", "noopener");
          toast.success(`Export ready · ${res.rowCount ?? 0} rows`);
          setDownloading(false);
        },
        onError: (e) => {
          toast.error(e.message || "Export failed");
          setDownloading(false);
        },
      },
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || downloading || exp.isPending}
      onClick={run}
      data-testid="export-csv"
    >
      {downloading || exp.isPending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="mr-1.5 h-3.5 w-3.5" />
      )}
      Export CSV
    </Button>
  );
}
