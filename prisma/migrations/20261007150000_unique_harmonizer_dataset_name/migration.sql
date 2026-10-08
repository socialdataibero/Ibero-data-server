-- El nombre de la edición es `_dataset` en la vista por encuesta: debe ser único
-- dentro de la encuesta (H-05). Las ediciones repetidas que ya existan se
-- renombran agregando " (2)", " (3)", … en orden de subida.
UPDATE "harmonizer_datasets" AS d
SET "name" = d."name" || ' (' || dup.n || ')'
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "surveyId", "name" ORDER BY "createdAt", "id") AS n
  FROM "harmonizer_datasets"
) AS dup
WHERE d."id" = dup."id" AND dup.n > 1;

-- DropIndex
DROP INDEX "harmonizer_datasets_surveyId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "harmonizer_datasets_surveyId_name_key" ON "harmonizer_datasets"("surveyId", "name");
