-- AlterTable
ALTER TABLE "harmonizer_mappings" ADD COLUMN     "missingCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
