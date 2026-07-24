import { prisma } from "../db/prisma";
import { getDownloadUrl, buildCaptionedVideoKey } from "../services/s3";
import { createJob, pollJobUntilDone, type NexrenderJobPayload } from "../services/nexrender";
import { QUESTION_TEXT, QUESTION_VO_KEY } from "../config/questions";
import { config } from "../config/env";
import type { JobRow } from "./types";

const COMPOSITION = "MainComp";

type BrandingConfig = { nexrender_template?: string };

export async function renderSegmentHandler(job: JobRow): Promise<void> {
  const { segment_id } = job.payload as { segment_id: string };

  const segment = await prisma.segment.findUniqueOrThrow({
    where: { id: segment_id },
    include: { distributor: { include: { client: true } } },
  });

  const existing = await prisma.renderedVideo.findUnique({ where: { segment_id } });
  if (existing?.status === "rendered") {
    return;
  }

  const questionText = QUESTION_TEXT[segment.question_index];
  const voKey = QUESTION_VO_KEY[segment.question_index];
  if (!questionText || !voKey) {
    throw new Error(`No question config for question_index ${segment.question_index}`);
  }

  const brandingConfig = segment.distributor.client.branding_config as BrandingConfig;
  const templateId = brandingConfig.nexrender_template;
  if (!templateId) {
    throw new Error(`Client ${segment.distributor.client.id} has no nexrender_template configured`);
  }

  const captionedVideoKey = buildCaptionedVideoKey(segment.video_key);
  const [videoUrl, voUrl] = await Promise.all([
    getDownloadUrl(captionedVideoKey),
    getDownloadUrl(voKey),
  ]);

  const outputPrefix = `clients/${segment.distributor.client_id}/distributors/${segment.distributor_id}/rendered/`;

  const payload: NexrenderJobPayload = {
    template: { id: templateId, composition: COMPOSITION },
    assets: [
      { type: "text", layerName: "Question_Text_Place", value: questionText },
      { type: "text", layerName: "Distributor_Name", value: segment.distributor.name },
      { type: "audio", layerName: "Question_VO_Place", src: voUrl },
      { type: "video", layerName: "Answer_Video_Place", src: videoUrl },
    ],
    upload: {
      provider: "s3",
      prefix: outputPrefix,
      outputUrl: `https://${config.S3_BUCKET_NAME}.s3.${config.AWS_REGION}.amazonaws.com`,
      params: {
        region: config.AWS_REGION,
        bucket: config.S3_BUCKET_NAME,
        // Defaults to https://s3.amazonaws.com (us-east-1) if omitted — wrong
        // for any other region, including ours (ap-south-1). This is what
        // actually broke, not outputUrl.
        endpoint: `https://s3.${config.AWS_REGION}.amazonaws.com`,
        accessKeyId: "${secrets.S3_ACCESS_KEY_ID}",
        accessKeySecret: "${secrets.S3_ACCESS_KEY_SECRET}",
      },
    },
  };

  const created = await createJob(payload);
  if (!created.outputUrl) {
    throw new Error(`nexrender job ${created.id} response had no outputUrl`);
  }
  const videoKey = new URL(created.outputUrl).pathname.replace(/^\//, "");

  await prisma.renderedVideo.upsert({
    where: { segment_id },
    create: { segment_id, video_key: videoKey, status: "rendering" },
    update: { video_key: videoKey, status: "rendering" },
  });

  const finished = await pollJobUntilDone(created.id);

  if (finished.status !== "finished") {
    await prisma.renderedVideo.update({ where: { segment_id }, data: { status: "failed" } });
    throw new Error(
      `nexrender job ${created.id} ended with status ${finished.status}: ${finished.stats?.error ?? "unknown error"}`,
    );
  }

  await prisma.renderedVideo.update({ where: { segment_id }, data: { status: "rendered" } });
}
