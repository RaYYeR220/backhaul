export const REPO = "https://github.com/RaYYeR220/backhaul";

export const links = {
  repo: REPO,
  docs: `${REPO}#readme`,
  trust: `${REPO}/blob/main/docs/TRUST.md`,
  app: "/app",
  status: "/status",
  attacks: "/attacks",
} as const;

/** Public reports behind the loss figures on the landing. */
export const sources = {
  ronin: "https://roninblockchain.substack.com/p/back-to-building-ronin-security-breach",
  harmony:
    "https://www.elliptic.co/insights/over-1-billion-stolen-from-bridges-so-far-in-2022-as-harmony-s-horizon-bridge-becomes-latest-victim-in-100-million-hack/",
  orbit: "https://blockworks.co/news/80-million-lost-orbit-bridge",
} as const;
