/** 140474097 → "140,474,097", the same on the server and in every browser. */
export const fmt = (n: number) => n.toLocaleString("en-US");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-03T00:02:16.905Z" → "03 Nov 2026 00:02 UTC" */
export function utcStamp(iso: string) {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${iso.slice(11, 16)} UTC`;
}
