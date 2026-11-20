import { $Enums } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  isApplicationStatus,
  toAppStatus,
  toPrismaStatus,
  type ApplicationStatus,
} from "@/lib/application-status";

export async function setJobApplication(
  jobId: string,
  status: ApplicationStatus | null,
) {
  if (status === null) {
    await db.jobApplication.deleteMany({ where: { jobId } });
    return { status: null, statusUpdatedAt: null };
  }

  const prismaStatus = toPrismaStatus(status) as $Enums.ApplicationStatus;

  const application = await db.jobApplication.upsert({
    where: { jobId },
    create: {
      jobId,
      status: prismaStatus,
    },
    update: {
      status: prismaStatus,
    },
  });

  return {
    status: toAppStatus(application.status),
    statusUpdatedAt: application.updatedAt.toISOString(),
  };
}

/** Bulk upsert (or clear) application status for many jobs in one transaction. */
export async function setManyJobApplications(
  jobIds: string[],
  status: ApplicationStatus | null,
): Promise<{ updated: number; status: ApplicationStatus | null }> {
  const uniqueIds = [...new Set(jobIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { updated: 0, status };
  }

  if (status === null) {
    const result = await db.jobApplication.deleteMany({
      where: { jobId: { in: uniqueIds } },
    });
    return { updated: result.count, status: null };
  }

  const prismaStatus = toPrismaStatus(status) as $Enums.ApplicationStatus;

  await db.$transaction(
    uniqueIds.map((jobId) =>
      db.jobApplication.upsert({
        where: { jobId },
        create: { jobId, status: prismaStatus },
        update: { status: prismaStatus },
      }),
    ),
  );

  return { updated: uniqueIds.length, status };
}

export function parseApplicationStatus(
  value: unknown,
): ApplicationStatus | null {
  if (value === null) return null;
  if (isApplicationStatus(value)) return value;
  return null;
}
