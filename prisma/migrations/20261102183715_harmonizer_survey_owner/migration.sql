-- AlterTable
ALTER TABLE "harmonizer_surveys" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

-- AddForeignKey
ALTER TABLE "harmonizer_surveys" ADD CONSTRAINT "harmonizer_surveys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harmonizer_surveys" ADD CONSTRAINT "harmonizer_surveys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
