-- Las filas crudas pasan a un Parquet por edición en storage/harmonizer/ (H-31).
-- Las ediciones existentes se quedarían sin datos, así que se borran (sus
-- mapeos se van en cascada); hay que volver a subirlas.
DELETE FROM "harmonizer_datasets";

-- DropForeignKey
ALTER TABLE "harmonizer_raw_rows" DROP CONSTRAINT "harmonizer_raw_rows_datasetId_fkey";

-- DropTable
DROP TABLE "harmonizer_raw_rows";
