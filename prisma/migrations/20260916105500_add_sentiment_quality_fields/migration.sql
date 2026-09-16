-- AlterTable
ALTER TABLE "sentiment_results" ADD COLUMN     "contains_profanity" BOOLEAN,
ADD COLUMN     "emotional_tone" TEXT;

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "language_probability" DECIMAL(65,30);
