import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config/env";

const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;

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

export function getUploadUrl(key: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: config.S3_BUCKET_NAME, Key: key });
  return getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
}
