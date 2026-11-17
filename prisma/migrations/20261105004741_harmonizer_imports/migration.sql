-- CreateEnum
CREATE TYPE "HarmonizerImportStatus" AS ENUM ('UPLOADING', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "harmonizer_imports" (
    "id" TEXT NOT NULL,
    "status" "HarmonizerImportStatus" NOT NULL DEFAULT 'UPLOADING',
    "phase" TEXT,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "format" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "surveyId" TEXT,
    "newSurveyName" TEXT,
    "organizationId" TEXT,
    "encoding" TEXT,
    "createdById" TEXT NOT NULL,
    "datasetId" TEXT,
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "harmonizer_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "harmonizer_imports_status_idx" ON "harmonizer_imports"("status");

-- AddForeignKey
ALTER TABLE "harmonizer_imports" ADD CONSTRAINT "harmonizer_imports_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "harmonizer_surveys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harmonizer_imports" ADD CONSTRAINT "harmonizer_imports_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
