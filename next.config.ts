import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable edge runtime for API routes
  experimental: {
    // Allow server actions if needed in the future
  },
};

export default nextConfig;
