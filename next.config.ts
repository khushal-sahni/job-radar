import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "patchright",
    "patchright-core",
    "playwright",
    "playwright-core",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ],
};

export default nextConfig;
