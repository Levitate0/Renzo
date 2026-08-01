/**
 * Renzo frontend — statically exported and served by the Express backend
 * (same pattern as Shiori's RenzoFrontend served by its ASP.NET backend).
 * No env validation layer: the app talks to whatever origin serves it.
 *
 * @type {import("next").NextConfig}
 */
const config = {
  output: "export",
  // Two lockfiles exist (backend + frontend) — pin the workspace root so
  // Turbopack doesn't infer the parent repo as the project root.
  turbopack: { root: import.meta.dirname },
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  distDir: "out",
  typescript: {
    // Typechecking runs separately (`npm run typecheck`); the build should not
    // die on a type error during iteration.
    ignoreBuildErrors: true,
  },
  images: {
    // Static export has no image optimizer, and artwork comes from the user's
    // own server + AniList CDNs at runtime anyway.
    unoptimized: true,
  },
};

export default config;
