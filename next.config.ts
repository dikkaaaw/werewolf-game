import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents is intentionally OFF (the scaffold enables it by default).
  //
  // With cacheComponents, Next 16 removes the route segment config options
  // `dynamic`, `revalidate`, `dynamicParams` and `fetchCache`. Every request in
  // this app is inherently dynamic — it reads auth cookies and talks to
  // Supabase — so those knobs have no meaning here and their removal is a
  // footgun. Leaving them off restores classic behaviour, where GET Route
  // Handlers are dynamic by default.
  //
  // See docs/IMPLEMENTATION-PLAN.md ("Framework decisions").
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
