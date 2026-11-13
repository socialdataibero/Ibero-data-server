-- AlterTable
-- A resource larger than 2 GB (an attached harmonized view) did not fit in INTEGER.
ALTER TABLE "resources" ALTER COLUMN "sizeBytes" SET DATA TYPE BIGINT;
