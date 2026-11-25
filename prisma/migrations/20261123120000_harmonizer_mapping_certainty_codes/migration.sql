-- Codes of a column with the sample role `certainty` that mark a completely enumerated stratum.
ALTER TABLE "harmonizer_mappings" ADD COLUMN "certaintyCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
