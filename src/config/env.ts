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

const OPTIONAL_VARS = ["MIN_APP_VERSION"] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number];
type OptionalVar = (typeof OPTIONAL_VARS)[number];

function loadEnv(): Record<RequiredVar, string> &
  Partial<Record<OptionalVar, string>> & {
    PORT: number;
    ENABLE_REEL_RENDERING: boolean;
    ENABLE_DEV_ENDPOINTS: boolean;
    ENABLE_SELF_REGISTRATION: boolean;
    JOB_VISIBILITY_TIMEOUT_MS: number;
    MIN_APP_VERSION: string;
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

  // Gates POST /register (src/routes/register.ts) - default off. Lets
  // internal test participants create their own Distributor row and get a
  // session without a seeded account, always under the fixed internal-test
  // Client (never client-supplied - see that file). Off by default, same
  // "route never registered at all" treatment as ENABLE_DEV_ENDPOINTS, so
  // it can never be accidentally live once real IFB provisioning exists.
  const enableSelfRegistration = process.env.ENABLE_SELF_REGISTRATION === "true";

  // How long a job can sit in `processing` before the worker treats it as
  // abandoned (crashed/killed worker) and reclaims it - see src/worker.ts.
  // Default (15 min) is deliberately longer than nexrender.ts's own 10-min
  // POLL_TIMEOUT_MS, since render_segment legitimately blocks the whole
  // time it's polling nexrender-cloud - the timeout here must never fire
  // on a render job that's still genuinely in flight.
  const jobVisibilityTimeoutMs = Number(process.env.JOB_VISIBILITY_TIMEOUT_MS) || 15 * 60 * 1000;

  // Global minimum app version, surfaced via GET /distributors/me so the
  // frontend can gate on it right where it already fetches the profile post-
  // auth. Not a DB field - it's config, not tenant data - and not gating
  // login itself yet (that would need an unauthenticated endpoint, deferred
  // until it's actually needed). Defaults to "0.0.0" so an unset var never
  // blocks anyone.
  const minAppVersion = process.env.MIN_APP_VERSION || "0.0.0";

  return {
    ...required,
    ...optional,
    PORT: Number(process.env.PORT) || 3000,
    ENABLE_REEL_RENDERING: enableReelRendering,
    ENABLE_DEV_ENDPOINTS: enableDevEndpoints,
    ENABLE_SELF_REGISTRATION: enableSelfRegistration,
    JOB_VISIBILITY_TIMEOUT_MS: jobVisibilityTimeoutMs,
    MIN_APP_VERSION: minAppVersion,
  };
}

export const config = loadEnv();
