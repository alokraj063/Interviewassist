export default function Banner({ banner }) {
  if (!banner || !banner.text) return null;
  return <div className="banner" data-kind={banner.kind || 'info'}>{banner.text}</div>;
}
