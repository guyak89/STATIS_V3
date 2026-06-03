import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Autorise l'accès depuis toutes les IPs Tailscale (plage 100.x.x.x)
  allowedDevOrigins: ["100.110.82.32", "100.112.30.36", "100.95.93.120", "100.*.*.*"],
  reactStrictMode: true,
  // mssql contient des modules natifs Node.js — ne pas bundler côté serveur
  serverExternalPackages: ["mssql", "tedious", "xlsx", "better-sqlite3"],
};

export default nextConfig;
