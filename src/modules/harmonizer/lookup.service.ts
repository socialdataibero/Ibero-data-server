import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Finds a survey or an edition, or throws its 404. Every area of the harmonizer uses it. */
@Injectable()
export class HarmonizerLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async getSurvey(surveyId: string) {
    const survey = await this.prisma.harmonizerSurvey.findUnique({
      where: { id: surveyId },
    });
    if (!survey) {
      throw new NotFoundException({
        code: 'survey_not_found',
        message: 'Survey not found.',
      });
    }
    return survey;
  }

  async getDataset(datasetId: string) {
    const dataset = await this.prisma.harmonizerDataset.findUnique({
      where: { id: datasetId },
      include: { survey: true },
    });
    if (!dataset) {
      throw new NotFoundException({
        code: 'harmonizer_dataset_not_found',
        message: 'Edition not found.',
      });
    }
    return dataset;
  }
}
