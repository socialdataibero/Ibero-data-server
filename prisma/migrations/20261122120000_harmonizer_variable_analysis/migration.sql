-- AlterTable
ALTER TABLE "harmonizer_canonical_variables" ADD COLUMN     "disaggregation" JSONB,
ADD COLUMN     "geoLevel" TEXT,
ADD COLUMN     "positiveValue" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "universe" TEXT;

-- AlterTable
ALTER TABLE "harmonizer_datasets" ADD COLUMN     "coverage" JSONB;

-- AlterTable
ALTER TABLE "harmonizer_surveys" ADD COLUMN     "shortName" TEXT;
