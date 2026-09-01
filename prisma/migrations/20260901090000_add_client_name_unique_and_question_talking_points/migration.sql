-- AlterTable
ALTER TABLE "questions" ADD COLUMN "talking_points" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "clients_name_key" ON "clients"("name");
