import type { ResumeProfile } from "./types";

const SENIORITY_KEYWORDS: Record<string, string[]> = {
  junior: ["junior", "entry", "associate", "0-2 years", "1-2 years"],
  mid: ["mid", "intermediate", "2-5 years", "3-5 years"],
  senior: ["senior", "sr.", "5+ years", "6+ years", "staff"],
  lead: ["lead", "principal", "architect", "staff engineer"],
};

export function scoreResumeFit(
  resume: ResumeProfile | null,
  title: string,
  description: string,
  tags: string[],
): { score: number; reasons: string[] } {
  if (!resume) {
    return { score: 0, reasons: ["Upload resume for fit scoring"] };
  }

  const text = `${title} ${description}`.toLowerCase();
  const reasons: string[] = [];
  let score = 40;

  const matchedSkills = resume.skills.filter((skill) =>
    text.includes(skill.toLowerCase()),
  );

  if (matchedSkills.length > 0) {
    const skillScore = Math.min(40, matchedSkills.length * 8);
    score += skillScore;
    reasons.push(`Skills match: ${matchedSkills.slice(0, 5).join(", ")}`);
  }

  const matchedTags = tags.filter((tag) =>
    resume.skills.some((s) => s.toLowerCase().includes(tag.toLowerCase()) || tag.toLowerCase().includes(s.toLowerCase())),
  );
  if (matchedTags.length > 0) {
    score += Math.min(10, matchedTags.length * 3);
  }

  if (resume.roles.some((role) => text.includes(role.toLowerCase()))) {
    score += 10;
    reasons.push("Role alignment");
  }

  if (resume.seniority) {
    const seniorityTerms = SENIORITY_KEYWORDS[resume.seniority] ?? [];
    if (seniorityTerms.some((term) => text.includes(term))) {
      score += 10;
      reasons.push(`Seniority fit (${resume.seniority})`);
    }
  }

  return {
    score: Math.min(100, Math.round(score)),
    reasons: reasons.length > 0 ? reasons : ["Partial text overlap"],
  };
}

export function extractSkillsFromText(text: string): string[] {
  const catalog: Array<{ label: string; match: RegExp }> = [
    { label: "TypeScript", match: /typescript/i },
    { label: "JavaScript", match: /javascript/i },
    { label: "Python", match: /python/i },
    { label: "Go", match: /\bgo\b|golang/i },
    { label: "Golang", match: /golang/i },
    { label: "Java", match: /\bjava\b/i },
    { label: "Rust", match: /\brust\b/i },
    { label: "Kotlin", match: /kotlin/i },
    { label: "Node.js", match: /node\.?js/i },
    { label: "React", match: /\breact\b/i },
    { label: "Next.js", match: /next\.?js/i },
    { label: "PostgreSQL", match: /postgres(ql)?/i },
    { label: "MongoDB", match: /mongodb/i },
    { label: "Redis", match: /redis/i },
    { label: "Kafka", match: /kafka/i },
    { label: "AWS", match: /\baws\b/i },
    { label: "GCP", match: /\bgcp\b|google cloud/i },
    { label: "Azure", match: /\bazure\b/i },
    { label: "Kubernetes", match: /kubernetes|\bk8s\b/i },
    { label: "Docker", match: /docker/i },
    { label: "GraphQL", match: /graphql/i },
    { label: "REST", match: /\brest\b/i },
    { label: "Microservices", match: /microservices/i },
    { label: "Distributed Systems", match: /distributed systems/i },
    { label: "System Design", match: /system design/i },
    { label: "Backend", match: /backend|back-end/i },
    { label: "Full Stack", match: /full[\s-]?stack/i },
    { label: "LLM", match: /\bllms?\b/i },
    { label: "OpenAI", match: /openai/i },
    { label: "LangChain", match: /langchain/i },
    { label: "RAG", match: /\brag\b/i },
    { label: "Agents", match: /\bagents?\b/i },
    { label: "Anthropic", match: /anthropic|claude/i },
  ];

  return catalog.filter(({ match }) => match.test(text)).map(({ label }) => label);
}

export function inferSeniority(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [level, keywords] of Object.entries(SENIORITY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return level;
  }
  if (/\b(\d+)\+?\s*years?\b/.test(lower)) {
    const years = Number(lower.match(/\b(\d+)\+?\s*years?\b/)?.[1] ?? 0);
    if (years >= 7) return "lead";
    if (years >= 4) return "senior";
    if (years >= 2) return "mid";
    return "junior";
  }
  return "senior";
}

export function inferRoles(text: string): string[] {
  const roles: string[] = [];
  const patterns = [
    "backend engineer",
    "full stack engineer",
    "fullstack engineer",
    "software engineer",
    "platform engineer",
    "systems engineer",
    "ai engineer",
    "llm engineer",
  ];
  const lower = text.toLowerCase();
  for (const role of patterns) {
    if (lower.includes(role)) roles.push(role);
  }
  if (roles.length === 0) roles.push("backend engineer");
  return roles;
}

export async function llmExtractResume(text: string): Promise<Partial<ResumeProfile>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return {};

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Extract resume profile as JSON: skills (string[]), seniority (junior|mid|senior|lead), roles (string[]).",
          },
          { role: "user", content: text.slice(0, 8000) },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) return {};

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return {};

    return JSON.parse(content) as Partial<ResumeProfile>;
  } catch {
    return {};
  }
}

export async function buildResumeProfile(rawText: string): Promise<ResumeProfile> {
  const heuristic: ResumeProfile = {
    skills: extractSkillsFromText(rawText),
    seniority: inferSeniority(rawText),
    roles: inferRoles(rawText),
    rawText,
  };

  const llm = await llmExtractResume(rawText);

  return {
    rawText,
    skills: [...new Set([...heuristic.skills, ...(llm.skills ?? [])])],
    seniority: llm.seniority ?? heuristic.seniority,
    roles: llm.roles ?? heuristic.roles,
  };
}
