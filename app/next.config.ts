import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // the app has its own lockfile; keep tracing inside it
  outputFileTracingRoot: path.resolve(__dirname),
};

export default config;
