const REQUIRED_VARS = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
  "ELEVENLABS_API_KEY",
  "GEMINI_API_KEY",
  "NEXRENDER_SERVER_URL",
  "NEXRENDER_API_KEY",
] as const;

const OPTIONAL_VARS = [] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number];
type OptionalVar = (typeof OPTIONAL_VARS)[number];

function loadEnv(): Record<RequiredVar, string> &
  Partial<Record<OptionalVar, string>> & {
    PORT: number;
    ENABLE_REEL_RENDERING: boolean;
    ENABLE_DEV_ENDPOINTS: boolean;
  } {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const required = Object.fromEntries(
    REQUIRED_VARS.map((key) => [key, process.env[key] as string]),
  ) as Record<RequiredVar, string>;

  // JWTs are the only thing standing between an unauthenticated request and
  // req.auth — a short/guessable secret makes every session forgeable.
  if (required.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long");
  }

  const optional = Object.fromEntries(
    OPTIONAL_VARS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<OptionalVar, string>>;

  // The branded-reel template isn't ready yet - default off (this build)
  // so render_segment jobs are never queued and nexrender is never called.
  // See src/jobs/transcribeSegment.ts, the only place this is read. The
  // frontend has its own independent EXPO_PUBLIC_ENABLE_REEL_RENDERING
  // flag (testimonial-app/config.ts) - keep both in sync.
  const enableReelRendering = process.env.ENABLE_REEL_RENDERING === "true";

  // Gates every internal/debug route (currently just GET /segments/sentiment,
  // see src/routes/dev.ts) - default off. These routes return data scoped by
  // client_id rather than the caller's own distributor_id, which is correct
  // for an internal inspection tool but would otherwise let any authenticated
  // distributor read every other distributor's transcripts/sentiment/
  // moderation flags for the same client. Off by default means the route is
  // never registered at all, not merely rejected - it shouldn't advertise its
  // own existence to a production caller.
  const enableDevEndpoints = process.env.ENABLE_DEV_ENDPOINTS === "true";

  return {
    ...required,
    ...optional,
    PORT: Number(process.env.PORT) || 3000,
    ENABLE_REEL_RENDERING: enableReelRendering,
    ENABLE_DEV_ENDPOINTS: enableDevEndpoints,
  };
}

export const config = loadEnv();
