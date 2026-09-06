import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Dev only: lets a phone on the LAN or a Cloudflare quick tunnel load the
  // dev server's chunks. Without it Next answers 403 for `/_next/*` from any
  // host but localhost and the page never hydrates.
  allowedDevOrigins: ["*.trycloudflare.com", "192.168.*.*"],
};

export default nextConfig;
