-- El tipo de una variable canónica pasa a ser opcional: NULL = sin confirmar.
-- Hasta ahora siempre valía 'text' por defecto y nadie lo eligió, así que se
-- borra para que el export infiera el tipo de los valores.
ALTER TABLE "harmonizer_canonical_variables" ALTER COLUMN "dataType" DROP NOT NULL,
ALTER COLUMN "dataType" DROP DEFAULT;

UPDATE "harmonizer_canonical_variables" SET "dataType" = NULL;
