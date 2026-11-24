-- Templates plan, phase 3b (D14): the analysis templates read the source metadata version 2
-- (`sourceMetadata`), written by the harmonizer. The hand-loaded variable metadata of the demo
-- goes away with its `PUT …/variable-metadata`.
ALTER TABLE "resources" DROP COLUMN "variableMetadata";
