declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    JOURNEY_SITE_SERVICE_TOKEN?: string;
    BUCKET?: R2Bucket;
  }
}
