export function Sparkline({ data, width = 80, height = 22, color = "hsl(var(--primary))" }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1 || 1);
  const points = data.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 2) - 1}`).join(" ");
  const last = data[data.length - 1];
  const lastY = height - ((last - min) / range) * (height - 2) - 1;
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(data.length - 1) * step} cy={lastY} r="1.8" fill={color} />
    </svg>
  );
}
