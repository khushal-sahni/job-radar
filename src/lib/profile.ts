import { db } from "@/lib/db";

export interface UserProfileData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedInUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  currentCompany: string;
  noticePeriod: string;
  expectedCtc: string;
  resumeSummary: string;
  resumeFilename: string | null;
  hasResumePdf: boolean;
}

export interface UserProfilePayload extends UserProfileData {
  resumePdfBase64?: string | null;
}

const DEFAULT_PROFILE: Omit<UserProfileData, "hasResumePdf"> & {
  hasResumePdf: boolean;
} = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  location: "",
  linkedInUrl: "",
  githubUrl: "",
  portfolioUrl: "",
  currentCompany: "",
  noticePeriod: "",
  expectedCtc: "",
  resumeSummary: "",
  resumeFilename: null,
  hasResumePdf: false,
};

function toProfileData(
  row: Awaited<ReturnType<typeof db.userProfile.findUnique>>,
  includePdf = false,
): UserProfilePayload {
  if (!row) {
    return { ...DEFAULT_PROFILE, resumePdfBase64: null };
  }

  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    location: row.location,
    linkedInUrl: row.linkedInUrl,
    githubUrl: row.githubUrl,
    portfolioUrl: row.portfolioUrl,
    currentCompany: row.currentCompany,
    noticePeriod: row.noticePeriod,
    expectedCtc: row.expectedCtc,
    resumeSummary: row.resumeSummary,
    resumeFilename: row.resumeFilename,
    hasResumePdf: Boolean(row.resumePdfBase64),
    resumePdfBase64: includePdf ? row.resumePdfBase64 : undefined,
  };
}

export async function getUserProfile(options?: {
  includeResumePdf?: boolean;
}): Promise<UserProfilePayload> {
  const row = await db.userProfile.findUnique({ where: { id: "default" } });
  if (row) {
    return toProfileData(row, options?.includeResumePdf ?? false);
  }

  const created = await db.userProfile.create({
    data: { id: "default" },
  });
  return toProfileData(created, options?.includeResumePdf ?? false);
}

export async function updateUserProfile(
  input: Partial<UserProfilePayload> & {
    resumePdfBase64?: string | null;
    resumeFilename?: string | null;
  },
): Promise<UserProfileData> {
  const data: Record<string, unknown> = {};

  const fields = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "location",
    "linkedInUrl",
    "githubUrl",
    "portfolioUrl",
    "currentCompany",
    "noticePeriod",
    "expectedCtc",
    "resumeSummary",
    "resumeFilename",
    "resumePdfBase64",
  ] as const;

  for (const field of fields) {
    if (field in input) {
      data[field] = input[field];
    }
  }

  const row = await db.userProfile.upsert({
    where: { id: "default" },
    create: { id: "default", ...data },
    update: data,
  });

  return toProfileData(row, false);
}

export async function syncResumePdfToProfile(
  filename: string,
  pdfBase64: string,
): Promise<void> {
  await db.userProfile.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      resumeFilename: filename,
      resumePdfBase64: pdfBase64,
    },
    update: {
      resumeFilename: filename,
      resumePdfBase64: pdfBase64,
    },
  });
}
