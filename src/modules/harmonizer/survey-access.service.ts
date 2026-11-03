import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';

/** Organization roles that may create and edit harmonizer surveys. */
export const SURVEY_EDITOR_ROLES: OrgRole[] = [OrgRole.ADMIN, OrgRole.EDITOR];

/**
 * Who may change a harmonizer survey and everything under it (SDI-91): the sysadmin, or an ADMIN/EDITOR of the
 * organization that owns it. Surveys created before ownership existed have no organization, so only the sysadmin
 * edits them. Reading stays open to any signed-in user.
 */
@Injectable()
export class SurveyAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanCreateIn(user: AuthenticatedUser, organizationId: string): Promise<void> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) {
      throw new NotFoundException({ code: 'organization_not_found', message: 'Organization not found.' });
    }
    if (user.isSysadmin || (await this.isEditorOf(user.id, organizationId))) return;
    throw new ForbiddenException({
      code: 'survey_org_role_required',
      message: 'Creating a survey requires the ADMIN or EDITOR role in its organization.',
    });
  }

  async assertCanEditSurvey(user: AuthenticatedUser, surveyId: string): Promise<void> {
    const survey = await this.prisma.harmonizerSurvey.findUnique({
      where: { id: surveyId },
      select: { organizationId: true },
    });
    if (!survey) {
      throw new NotFoundException({ code: 'survey_not_found', message: 'Survey not found.' });
    }
    if (user.isSysadmin) return;
    if (survey.organizationId && (await this.isEditorOf(user.id, survey.organizationId))) return;
    throw new ForbiddenException({
      code: 'survey_not_editable',
      message: 'Only the sysadmin or an ADMIN/EDITOR of the survey organization can change it.',
    });
  }

  async assertCanEditDataset(user: AuthenticatedUser, datasetId: string): Promise<void> {
    const dataset = await this.prisma.harmonizerDataset.findUnique({
      where: { id: datasetId },
      select: { surveyId: true },
    });
    if (!dataset) {
      throw new NotFoundException({ code: 'harmonizer_dataset_not_found', message: 'Dataset not found.' });
    }
    await this.assertCanEditSurvey(user, dataset.surveyId);
  }

  async assertCanEditCodebook(user: AuthenticatedUser, codebookId: string): Promise<void> {
    const codebook = await this.prisma.harmonizerCodebook.findUnique({
      where: { id: codebookId },
      select: { surveyId: true },
    });
    if (!codebook) {
      throw new NotFoundException({ code: 'codebook_not_found', message: 'Codebook not found.' });
    }
    await this.assertCanEditSurvey(user, codebook.surveyId);
  }

  private async isEditorOf(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true },
    });
    return membership !== null && SURVEY_EDITOR_ROLES.includes(membership.role);
  }
}
