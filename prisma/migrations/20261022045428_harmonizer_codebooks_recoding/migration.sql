-- AlterTable
ALTER TABLE "harmonizer_canonical_variables" ADD COLUMN     "categories" JSONB,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "reviewedSignature" TEXT;

-- AlterTable
ALTER TABLE "harmonizer_datasets" ADD COLUMN     "codebookId" TEXT,
ADD COLUMN     "codebookTable" TEXT;

-- AlterTable
ALTER TABLE "harmonizer_mappings" ADD COLUMN     "valueMap" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "harmonizer_codebooks" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harmonizer_codebooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harmonizer_codebook_variables" (
    "id" TEXT NOT NULL,
    "codebookId" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "question" TEXT,
    "section" TEXT,
    "declaredType" TEXT,
    "validRange" TEXT,
    "length" INTEGER,
    "categories" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "harmonizer_codebook_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harmonizer_column_profiles" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "sourceColumn" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "distinctCapped" BOOLEAN NOT NULL,
    "empty" INTEGER NOT NULL,

    CONSTRAINT "harmonizer_column_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "harmonizer_codebooks_surveyId_name_key" ON "harmonizer_codebooks"("surveyId", "name");

-- CreateIndex
CREATE INDEX "harmonizer_codebook_variables_codebookId_idx" ON "harmonizer_codebook_variables"("codebookId");

-- CreateIndex
CREATE UNIQUE INDEX "harmonizer_codebook_variables_codebookId_table_name_key" ON "harmonizer_codebook_variables"("codebookId", "table", "name");

-- CreateIndex
CREATE UNIQUE INDEX "harmonizer_column_profiles_datasetId_sourceColumn_key" ON "harmonizer_column_profiles"("datasetId", "sourceColumn");

-- AddForeignKey
ALTER TABLE "harmonizer_datasets" ADD CONSTRAINT "harmonizer_datasets_codebookId_fkey" FOREIGN KEY ("codebookId") REFERENCES "harmonizer_codebooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harmonizer_codebooks" ADD CONSTRAINT "harmonizer_codebooks_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "harmonizer_surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harmonizer_codebook_variables" ADD CONSTRAINT "harmonizer_codebook_variables_codebookId_fkey" FOREIGN KEY ("codebookId") REFERENCES "harmonizer_codebooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harmonizer_column_profiles" ADD CONSTRAINT "harmonizer_column_profiles_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "harmonizer_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
