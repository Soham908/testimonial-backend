// Dummy values for every required env var - src/config/env.ts throws at
// import time if any is missing. Tests never touch a real database or
// external service: each test file mocks `../src/db/prisma` and (where
// relevant) `../src/services/s3` directly, so these values only need to be
// well-formed enough that `loadEnv()` doesn't reject them, never actually
// connect to anything.
process.env.DATABASE_URL ??= "postgresql://user:password@localhost:5432/test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
process.env.AWS_REGION ??= "ap-south-1";
process.env.AWS_ACCESS_KEY_ID ??= "test-access-key-id";
process.env.AWS_SECRET_ACCESS_KEY ??= "test-secret-access-key";
process.env.S3_BUCKET_NAME ??= "test-bucket";
process.env.ELEVENLABS_API_KEY ??= "test-elevenlabs-key";
process.env.GEMINI_API_KEY ??= "test-gemini-key";
process.env.NEXRENDER_SERVER_URL ??= "https://example.invalid/api";
process.env.NEXRENDER_API_KEY ??= "test-nexrender-key";
