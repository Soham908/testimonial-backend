-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "is_branded" BOOLEAN NOT NULL DEFAULT false,
    "text_en" TEXT NOT NULL,
    "text_hi" TEXT NOT NULL,
    "text_mr" TEXT NOT NULL,
    "vo_key_en" TEXT NOT NULL,
    "vo_key_hi" TEXT NOT NULL,
    "vo_key_mr" TEXT NOT NULL,
    "extraction_spec" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "questions_client_id_index_key" ON "questions"("client_id", "index");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
