-- Rename the VizCanvas product to vistrace without losing data
ALTER TYPE "AnalysisOrigin" RENAME VALUE 'VIZCANVAS' TO 'VISTRACE';

ALTER TABLE "analyses" RENAME COLUMN "vizcanvasRecipe" TO "vistraceRecipe";
