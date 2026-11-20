(function () {
  const ns = (window.JobRadarLi = window.JobRadarLi || {});

  const LANGUAGE_PATTERNS = [
    { canonical: "typescript", pattern: /\btypescript\b/gi },
    { canonical: "javascript", pattern: /\bjavascript\b|\bnode\.?js\b|\bnodejs\b/gi },
    { canonical: "python", pattern: /\bpython\b/gi },
    { canonical: "csharp", pattern: /\bc#\b|\bcsharp\b|\bc-sharp\b/gi },
    { canonical: "kotlin", pattern: /\bkotlin\b/gi },
    { canonical: "rust", pattern: /\brust\b/gi },
    { canonical: "ruby", pattern: /\bruby\b/gi },
    { canonical: "scala", pattern: /\bscala\b/gi },
    { canonical: "php", pattern: /\bphp\b/gi },
    { canonical: "go", pattern: /\bgolang\b|\bgo\b/gi },
    { canonical: "java", pattern: /\bjava\b/gi },
  ];

  const ALIASES = {
    java: "java",
    typescript: "typescript",
    javascript: "javascript",
    js: "javascript",
    "node.js": "javascript",
    nodejs: "javascript",
    node: "javascript",
    python: "python",
    go: "go",
    golang: "go",
    rust: "rust",
    kotlin: "kotlin",
    ruby: "ruby",
    php: "php",
    csharp: "csharp",
    "c#": "csharp",
    scala: "scala",
  };

  const ANY_LANGUAGE_CLAUSE =
    /\bany\s+(?:[\w-]+\s+){0,4}languages?\b|\b(?:polyglot|language[-\s]?agnostic)\b/i;
  const HARD_REQUIREMENT =
    /\b(?:required|must have|mandatory|expertise in|strong (?:hands[-\s]?on )?experience (?:in|with)|hands[-\s]?on expertise in|\d+\+?\s*years?(?:\s+of)?)\b/i;

  const SKILL_CATALOG = [
    "TypeScript",
    "JavaScript",
    "Python",
    "Go",
    "Java",
    "Rust",
    "Kotlin",
    "Node.js",
    "React",
    "Next.js",
    "PostgreSQL",
    "Redis",
    "Kafka",
    "AWS",
    "GCP",
    "Azure",
    "Kubernetes",
    "Docker",
    "GraphQL",
    "Microservices",
    "Backend",
  ];

  function canonicalizeLanguage(raw) {
    const key = String(raw || "").trim().toLowerCase();
    return ALIASES[key] || null;
  }

  function extractLanguages(text) {
    const found = new Set();
    if (!text) return found;
    for (const { canonical, pattern } of LANGUAGE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) found.add(canonical);
    }
    return found;
  }

  function languagesFromSkills(skills) {
    const found = new Set();
    for (const skill of skills || []) {
      const aliased = canonicalizeLanguage(skill);
      if (aliased) {
        found.add(aliased);
        continue;
      }
      for (const lang of extractLanguages(skill)) found.add(lang);
    }
    return found;
  }

  function isExclusiveAvoidedSet(languages, avoid) {
    if (languages.size === 0) return false;
    for (const lang of languages) {
      if (!avoid.has(lang)) return false;
    }
    return true;
  }

  function hasHardExclusiveRequirement(text, avoid) {
    const lower = text.toLowerCase();
    for (const lang of avoid) {
      const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "gi");
      for (const match of lower.matchAll(re)) {
        const idx = match.index ?? 0;
        const window = lower.slice(Math.max(0, idx - 80), idx + lang.length + 80);
        if (!HARD_REQUIREMENT.test(window)) continue;
        const others = extractLanguages(window);
        others.delete(lang);
        if (others.size > 0) continue;
        return true;
      }
    }
    return false;
  }

  function isExclusiveAvoidedLanguageJob(input) {
    const avoid = new Set();
    for (const raw of input.avoidLanguages || []) {
      const canonical = canonicalizeLanguage(raw) || String(raw).trim().toLowerCase();
      if (canonical) avoid.add(canonical);
    }
    if (avoid.size === 0) return false;

    const userLangs = languagesFromSkills(input.resumeSkills || []);
    for (const lang of avoid) {
      if (userLangs.has(lang)) return false;
    }

    const haystack = `${input.title}\n${input.description}`;
    if (ANY_LANGUAGE_CLAUSE.test(haystack)) return false;

    const primary = extractLanguages(`${input.title} ${(input.tags || []).join(" ")}`);
    if (isExclusiveAvoidedSet(primary, avoid)) return true;
    if (primary.size > 0) return false;

    const body = extractLanguages(input.description || "");
    if (isExclusiveAvoidedSet(body, avoid)) return true;
    return body.size === 0 && hasHardExclusiveRequirement(haystack, avoid);
  }

  function matchExcludeTitleKeyword(title, keywords) {
    if (!keywords?.length) return null;
    const lower = String(title || "").toLowerCase();
    for (const kw of keywords) {
      const needle = String(kw).trim().toLowerCase();
      if (!needle) continue;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) return needle;
    }
    return null;
  }

  function parseRequiredYears(text) {
    const haystack = String(text || "").toLowerCase();
    const rangeMatch = haystack.match(
      /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:\+?\s*)?years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)?/i,
    );
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (lo <= 30 && hi <= 30) return { min: lo, max: hi };
    }
    let min;
    const patterns = [
      /(?:minimum|min\.?|at least|requires?)\s*(?:of\s+)?(\d+)\s*(?:\+?\s*)?years?/gi,
      /(\d+)\s*\+\s*years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)?/gi,
      /(\d+)\s+years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of haystack.matchAll(pattern)) {
        const years = Number(match[1]);
        if (years >= 0 && years <= 30) {
          min = min == null ? years : Math.max(min, years);
        }
      }
    }
    return { min, max: undefined };
  }

  function inferCountry(location, description) {
    const hay = `${location || ""} ${description || ""}`.toLowerCase();
    if (/\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|chennai|pune|gurgaon|noida)\b/.test(hay)) {
      return "IN";
    }
    if (/\b(germany|berlin|munich|münchen|frankfurt|hamburg|stuttgart)\b/.test(hay)) {
      return "DE";
    }
    if (/\b(japan|tokyo|osaka|yokohama)\b/.test(hay)) {
      return "JP";
    }
    return null;
  }

  function isRemoteHint(location, workplaceType, description) {
    const hay = `${location || ""} ${workplaceType || ""} ${description || ""}`.toLowerCase();
    if (/\bon-?site\b/.test(hay) && !/\bremote\b/.test(hay)) return false;
    return /\b(remote|work from home|wfh)\b/.test(hay);
  }

  function hasSalarySignal(text) {
    return /₹|inr|\blpa\b|€|eur|¥|jpy|\$\s?\d|salary|ctc/i.test(text || "");
  }

  function hasVisaSignal(text) {
    return /\b(visa\s+sponsor|sponsorship|work\s+permit|relocation)\b/i.test(text || "");
  }

  function matchingSkills(skills, text) {
    const hay = String(text || "").toLowerCase();
    const fromResume = (skills || []).filter((s) => hay.includes(String(s).toLowerCase()));
    const fromCatalog = SKILL_CATALOG.filter((s) => hay.includes(s.toLowerCase()));
    return [...new Set([...fromResume, ...fromCatalog])].slice(0, 8);
  }

  function hintRuleBranch(job, rules) {
    const country = inferCountry(job.location, job.description);
    const remote = isRemoteHint(job.location, job.workplaceType, job.description);
    const list = Array.isArray(rules) ? rules : [];
    for (const branch of list) {
      if (branch.remote === true && remote) return branch.id || "remote";
      if (branch.remote === false && branch.country === "IN" && country === "IN" && !remote) {
        return branch.id || "india-onsite";
      }
      if (branch.country === "DE" && country === "DE") return branch.id || "germany";
      if (branch.country === "JP" && country === "JP") return branch.id || "japan";
    }
    if (country === "IN") return remote ? "remote-india" : "india-onsite";
    if (country === "DE") return "germany";
    if (country === "JP") return "japan";
    if (remote) return "remote";
    return null;
  }

  /**
   * @returns {{
   *   excluded: boolean,
   *   excludeReason: string | null,
   *   score: number,
   *   fits: number,
   *   total: number,
   *   chips: Array<{ id: string, label: string, state: 'pass'|'fail'|'unknown' }>,
   *   matchedSkills: string[],
   *   branchId: string | null,
   *   reasons: string[],
   *   level: 'green'|'yellow'|'red'
   * }}
   */
  function scoreJob(job, ctx) {
    const prefs = ctx?.prefs || {};
    const rules = ctx?.rules || [];
    const skills = ctx?.skills || [];
    const userYears = Number(prefs.yearsOfExperience ?? 4);
    const title = job.title || "";
    const description = `${job.snippet || ""}\n${job.description || ""}`;
    const haystack = `${title}\n${job.company || ""}\n${job.location || ""}\n${description}`;

    const excludedKw = matchExcludeTitleKeyword(
      title,
      prefs.excludeTitleKeywords || [],
    );
    const exclusiveLang = isExclusiveAvoidedLanguageJob({
      title,
      description,
      tags: job.tags || [],
      resumeSkills: skills,
      avoidLanguages: prefs.avoidIfExclusiveLanguages || ["java"],
    });

    if (excludedKw) {
      return {
        excluded: true,
        excludeReason: `Title contains “${excludedKw}”`,
        score: 0,
        fits: 0,
        total: 4,
        chips: [
          { id: "title", label: "Title ✕", state: "fail" },
          { id: "stack", label: "Stack ?", state: "unknown" },
          { id: "yoe", label: "YOE ?", state: "unknown" },
          { id: "loc", label: "Loc ?", state: "unknown" },
        ],
        matchedSkills: [],
        branchId: null,
        reasons: [`Excluded: title contains “${excludedKw}”`],
        level: "red",
      };
    }

    if (exclusiveLang) {
      return {
        excluded: true,
        excludeReason: "Exclusive avoided stack",
        score: 0,
        fits: 0,
        total: 4,
        chips: [
          { id: "title", label: "Title ✓", state: "pass" },
          { id: "stack", label: "Stack ✕", state: "fail" },
          { id: "yoe", label: "YOE ?", state: "unknown" },
          { id: "loc", label: "Loc ?", state: "unknown" },
        ],
        matchedSkills: [],
        branchId: null,
        reasons: ["Excluded: exclusive language stack (e.g. Java-only)"],
        level: "red",
      };
    }

    const yoe = parseRequiredYears(haystack);
    let yoeState = "unknown";
    if (yoe.min != null) yoeState = yoe.min <= userYears ? "pass" : "fail";

    const country = inferCountry(job.location, description);
    const remote = isRemoteHint(job.location, job.workplaceType, description);
    let locState = "unknown";
    if (country || remote) locState = "pass";
    if (
      job.location &&
      !country &&
      !remote &&
      /united states|usa|uk|united kingdom|canada|australia/i.test(job.location)
    ) {
      locState = "fail";
    }

    const salaryText = haystack;
    const salaryState = hasSalarySignal(salaryText) ? "pass" : "unknown";
    const visaState =
      country === "DE" || country === "JP"
        ? hasVisaSignal(salaryText)
          ? "pass"
          : "unknown"
        : "unknown";

    const skillsMatched = matchingSkills(skills, haystack);
    const branchId = hintRuleBranch(job, rules);

    const chips = [
      { id: "title", label: "Title ✓", state: "pass" },
      { id: "stack", label: "Stack ✓", state: "pass" },
      {
        id: "yoe",
        label:
          yoeState === "unknown"
            ? "YOE ?"
            : yoeState === "pass"
              ? "YOE ✓"
              : `YOE ✕ ${yoe.min}+`,
        state: yoeState,
      },
      {
        id: "loc",
        label:
          locState === "unknown"
            ? "Loc ?"
            : locState === "pass"
              ? country
                ? `Loc ${country}${remote ? " remote" : ""}`
                : "Remote"
              : "Loc ✕",
        state: locState,
      },
      {
        id: "salary",
        label: salaryState === "pass" ? "Salary ✓" : "Salary ?",
        state: salaryState,
      },
    ];

    if (country === "DE" || country === "JP") {
      chips.push({
        id: "visa",
        label: visaState === "pass" ? "Visa ✓" : "Visa ?",
        state: visaState,
      });
    }

    const core = chips.filter((c) => ["title", "stack", "yoe", "loc"].includes(c.id));
    const fits = core.filter((c) => c.state === "pass").length;
    const fails = core.filter((c) => c.state === "fail").length;
    const total = 4;

    let score = 40;
    score += Math.min(40, skillsMatched.length * 8);
    if (yoeState === "pass") score += 10;
    if (yoeState === "fail") score -= 25;
    if (locState === "pass") score += 10;
    if (locState === "fail") score -= 20;
    if (salaryState === "pass") score += 5;
    if (branchId) score += 8;
    score = Math.max(0, Math.min(100, Math.round(score)));

    const reasons = [];
    if (skillsMatched.length) reasons.push(`Skills: ${skillsMatched.slice(0, 5).join(", ")}`);
    if (yoe.min != null) reasons.push(`Requires ${yoe.min}+ yrs (you: ${userYears})`);
    if (branchId) reasons.push(`Looks like ${branchId}`);
    if (salaryState === "unknown") reasons.push("Salary not listed on card");

    let level = "yellow";
    if (fails > 0 || score < 45) level = "red";
    else if (fits >= 3 && score >= 70) level = "green";

    return {
      excluded: false,
      excludeReason: null,
      score,
      fits,
      total,
      chips,
      matchedSkills: skillsMatched,
      branchId,
      reasons: reasons.length ? reasons : ["Partial overlap"],
      level,
    };
  }

  ns.scorer = {
    scoreJob,
    matchExcludeTitleKeyword,
    isExclusiveAvoidedLanguageJob,
    parseRequiredYears,
  };
})();
