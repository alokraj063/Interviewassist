import logoImg from "@/assets/logo.png";

export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean }) {
  // The logo is a wide wordmark — we render it at a height proportional to `size`.
  const height = withText ? Math.round(size * 1.15) : size;
  return (
    <div className="flex items-center">
      <img
        src={logoImg}
        alt="Joules to Watts"
        style={{ height, width: "auto" }}
        className="block select-none"
        draggable={false}
      />
    </div>
  );
}
