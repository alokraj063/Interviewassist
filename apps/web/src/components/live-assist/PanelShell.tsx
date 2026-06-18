import { cn } from "@/lib/utils";

export function PanelShell({
  title,
  action,
  children,
  bodyClass,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="h-full bg-card border border-border rounded-lg flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
        {action}
      </div>
      <div className={cn("flex-1 min-h-0 overflow-y-auto", bodyClass)}>{children}</div>
    </div>
  );
}
