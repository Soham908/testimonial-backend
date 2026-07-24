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
  Partial<Record<OptionalVar, string>> & { PORT: number } {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const required = Object.fromEntries(
    REQUIRED_VARS.map((key) => [key, process.env[key] as string]),
  ) as Record<RequiredVar, string>;

  const optional = Object.fromEntries(
    OPTIONAL_VARS.map((key) => [key, process.env[key]]),
  ) as Partial<Record<OptionalVar, string>>;

  return { ...required, ...optional, PORT: Number(process.env.PORT) || 3000 };
}

export const config = loadEnv();
