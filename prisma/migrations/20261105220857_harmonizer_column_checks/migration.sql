-- CreateTable
CREATE TABLE "harmonizer_column_checks" (
    "datasetId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harmonizer_column_checks_pkey" PRIMARY KEY ("datasetId","key")
);

-- AddForeignKey
ALTER TABLE "harmonizer_column_checks" ADD CONSTRAINT "harmonizer_column_checks_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "harmonizer_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
