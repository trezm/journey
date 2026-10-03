// The previous Site host remains a read-only handoff after the Cloudflare cutover.
// It deliberately has no database, bucket, authentication, or application imports.
const origin = "https://journey.peter-s-mertz.workers.dev";

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    if ((request.method === "GET" || request.method === "HEAD") &&
        path !== "/api" && !path.startsWith("/api/") &&
        !path.startsWith("/__journey_migration_")) {
      return new Response(null, { status: 302, headers: { ...headers, Location: origin } });
    }
    return Response.json({
      error: "site_moved",
      message: "Journey has moved to Cloudflare. Update your connection URL before retrying.",
      origin,
    }, { status: 410, headers });
  },
};
