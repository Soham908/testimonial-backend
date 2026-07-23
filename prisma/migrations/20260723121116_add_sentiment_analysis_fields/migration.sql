/*
  Warnings:

  - Added the required column `best_quote` to the `sentiment_results` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contains_complaint` to the `sentiment_results` table without a default value. This is not possible if the table is not empty.
  - Added the required column `highlight_score` to the `sentiment_results` table without a default value. This is not possible if the table is not empty.
  - Added the required column `is_relevant` to the `sentiment_results` table without a default value. This is not possible if the table is not empty.
  - Added the required column `moderation_flag` to the `sentiment_results` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "sentiment_results" ADD COLUMN     "actionable_feedback" TEXT,
ADD COLUMN     "best_quote" TEXT NOT NULL,
ADD COLUMN     "contains_complaint" BOOLEAN NOT NULL,
ADD COLUMN     "highlight_score" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "is_relevant" BOOLEAN NOT NULL,
ADD COLUMN     "moderation_flag" BOOLEAN NOT NULL;
