import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config/env";

const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;
const DOWNLOAD_URL_EXPIRY_SECONDS = 15 * 60;

const s3 = new S3Client({
  region: config.AWS_REGION,
  credentials: {
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  },
});

export function buildSegmentVideoKey(
  clientId: string,
  distributorId: string,
  questionIndex: number,
): string {
  return `clients/${clientId}/distributors/${distributorId}/segments/${questionIndex}.mp4`;
}

// Intermediate artifact, never read back through any API — feeds nexrender
// only. Deterministic from video_key, same convention as srt/vtt keys, so
// no DB column is needed to track it; existence is the idempotency check.
export function buildCaptionedVideoKey(videoKey: string): string {
  return videoKey.replace(/\.[^.]+$/, ".captioned.mp4");
}

export function getUploadUrl(key: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: key });
  return getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
}

export function getDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: key });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: key }));
    return true;
  } catch (err) {
    // HeadObject's error body is empty (HEAD responses never have one), so the
    // SDK can't parse a named error — it surfaces as "UnknownError" regardless
    // of cause, and the HTTP status code is the only reliable signal.
    //
    // Without s3:ListBucket on this IAM user (scoped to GetObject/PutObject
    // only, deliberately least-privilege), S3 returns 403 rather than 404 for
    // a nonexistent key — it won't confirm-or-deny existence to a caller
    // without list permission. Since every key we check here is one we
    // generated ourselves (our own naming convention, our own bucket), a 403
    // in this context means "not found", not a real authorization boundary.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404 || status === 403) {
      return false;
    }
    throw err;
  }
}

export async function uploadTextObject(
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function uploadFileObject(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const { size } = await stat(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET_NAME,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
  );
}
