-- AlterTable
ALTER TABLE "harmonizer_datasets" ADD COLUMN     "design" TEXT,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "harmonizer_imports" ADD COLUMN     "design" TEXT,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "harmonizer_mappings" ADD COLUMN     "role" TEXT;
