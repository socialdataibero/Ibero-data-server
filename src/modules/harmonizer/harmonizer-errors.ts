import { ConflictException, NotFoundException } from '@nestjs/common';

/** Errors thrown from more than one place (the service, the tus uploads and the worker). */

export function codebookNotFound() {
  return new NotFoundException({
    code: 'codebook_not_found',
    message: 'Dictionary not found.',
  });
}

export function datasetNameTaken(name: string, surveyName: string) {
  return new ConflictException({
    code: 'dataset_name_taken',
    message: `Survey "${surveyName}" already has an edition named "${name}".`,
    params: { survey: surveyName, name },
  });
}
