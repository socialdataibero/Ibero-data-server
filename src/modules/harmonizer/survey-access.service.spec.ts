import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { OrgRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { SurveyAccessService } from './survey-access.service.js';

const ORG = 'org-1';
const user = (isSysadmin = false): AuthenticatedUser => ({
  id: 'user-1',
  email: 'u@example.org',
  fullName: 'U',
  isSysadmin,
});

function makeService(opts: { surveyOrg?: string | null; role?: OrgRole | null; orgExists?: boolean }) {
  const prisma = {
    organization: { findUnique: vi.fn(async () => (opts.orgExists === false ? null : { id: ORG })) },
    harmonizerSurvey: {
      findUnique: vi.fn(async () =>
        opts.surveyOrg === undefined ? null : { organizationId: opts.surveyOrg },
      ),
    },
    harmonizerDataset: { findUnique: vi.fn(async () => ({ surveyId: 'survey-1' })) },
    harmonizerCodebook: { findUnique: vi.fn(async () => ({ surveyId: 'survey-1' })) },
    organizationMember: { findUnique: vi.fn(async () => (opts.role ? { role: opts.role } : null)) },
  };
  return new SurveyAccessService(prisma as unknown as PrismaService);
}

describe('SurveyAccessService (SDI-91)', () => {
  it('lets ADMIN and EDITOR members create surveys in their organization', async () => {
    await expect(makeService({ role: 'ADMIN' }).assertCanCreateIn(user(), ORG)).resolves.toBeUndefined();
    await expect(makeService({ role: 'EDITOR' }).assertCanCreateIn(user(), ORG)).resolves.toBeUndefined();
  });

  it('rejects plain members and users without an organization', async () => {
    await expect(makeService({ role: 'MEMBER' }).assertCanCreateIn(user(), ORG)).rejects.toThrow(ForbiddenException);
    await expect(makeService({ role: null }).assertCanCreateIn(user(), ORG)).rejects.toThrow(ForbiddenException);
  });

  it('returns 404 for an unknown organization', async () => {
    await expect(makeService({ orgExists: false }).assertCanCreateIn(user(true), ORG)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lets editors of the owning organization change a survey, and nobody else', async () => {
    await expect(makeService({ surveyOrg: ORG, role: 'EDITOR' }).assertCanEditSurvey(user(), 's')).resolves.toBeUndefined();
    await expect(makeService({ surveyOrg: ORG, role: 'MEMBER' }).assertCanEditSurvey(user(), 's')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(makeService({ surveyOrg: ORG, role: null }).assertCanEditSurvey(user(), 's')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('leaves surveys without an organization to the sysadmin only', async () => {
    await expect(makeService({ surveyOrg: null, role: 'ADMIN' }).assertCanEditSurvey(user(), 's')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(makeService({ surveyOrg: null }).assertCanEditSurvey(user(true), 's')).resolves.toBeUndefined();
  });

  it('checks datasets and codebooks through their survey', async () => {
    await expect(makeService({ surveyOrg: ORG, role: null }).assertCanEditDataset(user(), 'd')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(makeService({ surveyOrg: ORG, role: 'ADMIN' }).assertCanEditCodebook(user(), 'c')).resolves.toBeUndefined();
  });

  it('returns 404 for an unknown survey', async () => {
    await expect(makeService({}).assertCanEditSurvey(user(true), 'missing')).rejects.toThrow(NotFoundException);
  });
});
