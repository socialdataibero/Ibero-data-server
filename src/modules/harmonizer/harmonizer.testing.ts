import type { AnalysisService } from '../analysis/analysis.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LocalStorageService } from '../storage/local-storage.service.js';
import { CodebooksService } from './codebooks/codebooks.service.js';
import { HarmonizerLookupService } from './lookup.service.js';
import { EditionFilesService } from './editions/edition-files.service.js';
import { EditionFilesSweepService } from './editions/edition-files-sweep.service.js';
import { ColumnProfilesService } from './profiles/column-profiles.service.js';
import { SurveysService } from './surveys/surveys.service.js';
import { EditionsService } from './editions/editions.service.js';
import { SyncUploadService } from './import/sync-upload.service.js';
import { EditionReaderService } from './editions/edition-reader.service.js';
import { MappingTypesService } from './mapping/mapping-types.service.js';
import { VariablesService } from './variables/variables.service.js';
import { MappingService } from './mapping/mapping.service.js';
import { ViewsService } from './views/views.service.js';
import { ExportsService } from './views/exports.service.js';

/**
 * For specs only: the harmonizer services wired by hand, the way Nest wires them in
 * HarmonizerModule. Specs pass fakes for what they do not use.
 */
export function createHarmonizerServices(
  prisma: PrismaService,
  analysis: AnalysisService,
  storage: LocalStorageService,
) {
  const lookup = new HarmonizerLookupService(prisma);
  const codebooks = new CodebooksService(prisma, lookup);
  const files = new EditionFilesService(storage);
  const sweep = new EditionFilesSweepService(prisma, storage, files);
  const profiles = new ColumnProfilesService(prisma, analysis, files);
  const surveys = new SurveysService(prisma, storage, lookup, files);
  const editions = new EditionsService(prisma, storage, lookup, files);
  const upload = new SyncUploadService(
    prisma,
    analysis,
    storage,
    lookup,
    surveys,
    profiles,
  );
  const reader = new EditionReaderService(prisma);
  const types = new MappingTypesService(prisma, analysis, files);
  const variables = new VariablesService(
    prisma,
    lookup,
    codebooks,
    profiles,
    types,
  );
  const mapping = new MappingService(
    prisma,
    lookup,
    codebooks,
    profiles,
    types,
  );
  const views = new ViewsService(
    prisma,
    analysis,
    lookup,
    files,
    reader,
    variables,
  );
  const exports = new ExportsService(
    prisma,
    analysis,
    storage,
    lookup,
    files,
    reader,
    variables,
  );
  return {
    lookup,
    codebooks,
    files,
    sweep,
    profiles,
    surveys,
    editions,
    upload,
    reader,
    types,
    variables,
    mapping,
    views,
    exports,
  };
}
