import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { domainToASCII } from "node:url";

export async function loadDomainList(dataDirectory) {
  const entries = new Map();
  for (const fileName of await readdir(dataDirectory)) {
    const filePath = path.join(dataDirectory, fileName);
    entries.set(fileName, await readFile(filePath, "utf8"));
  }
  return loadDomainListFromEntries(entries);
}

export function loadDomainListFromEntries(entries) {
  const affiliations = new Map();

  for (const content of entries.values()) {
    for (const line of usefulLines(content)) {
      const rule = parseDomainRule(line);
      if (!rule) continue;
      for (const affiliation of rule.affiliations) {
        const rules = affiliations.get(affiliation) ?? [];
        rules.push(rule);
        affiliations.set(affiliation, rules);
      }
    }
  }

  const memo = new Map();

  async function expand(category, stack = []) {
    if (memo.has(category)) return memo.get(category);
    if (stack.includes(category)) {
      throw new Error(`Circular category include: ${[...stack, category].join(" -> ")}`);
    }

    if (!entries.has(category) && !affiliations.has(category)) {
      throw new Error(`Unknown v2fly category: ${category}`);
    }
    const content = entries.get(category) ?? "";

    const rules = [...(affiliations.get(category) ?? [])];
    for (const line of usefulLines(content)) {
      const include = parseInclude(line);
      if (include) {
        const included = await expand(include.category, [...stack, category]);
        rules.push(...included.filter((rule) => matchesAttributes(rule, include.filters)));
        continue;
      }

      const rule = parseDomainRule(line);
      if (rule) rules.push(rule);
    }

    memo.set(category, rules);
    return rules;
  }

  return { expand };
}

export function normalizeDomain(value) {
  const ascii = domainToASCII(value.trim().toLowerCase().replace(/^\*\./, ""));
  if (!ascii || !ascii.includes(".") || ascii.length > 253) return null;
  if (!ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return null;
  }
  return ascii;
}

export function parseManualEntries(content, { allowCategories = false } = {}) {
  const result = { categories: [], domains: [], ips: [], cidrs: [] };

  for (const line of usefulLines(content)) {
    const token = line.split(/\s+/)[0];
    if (allowCategories && token.startsWith("category:")) {
      result.categories.push(token.slice("category:".length));
    } else if (token.startsWith("ip:")) {
      result.ips.push(token.slice("ip:".length));
    } else if (token.startsWith("cidr:")) {
      result.cidrs.push(token.slice("cidr:".length));
    } else {
      const raw = token.replace(/^(?:domain|full):/, "");
      if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(raw)) {
        (raw.includes("/") ? result.cidrs : result.ips).push(raw);
      } else {
        const domain = normalizeDomain(raw);
        if (domain) result.domains.push(domain);
      }
    }
  }

  return result;
}

function usefulLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

function parseInclude(line) {
  const [token, ...metadata] = line.split(/\s+/);
  if (!token.startsWith("include:")) return null;
  return {
    category: token.slice("include:".length),
    filters: metadata.filter((part) => part.startsWith("@")),
  };
}

function parseDomainRule(line) {
  const [token, ...metadata] = line.split(/\s+/);
  if (token.startsWith("include:") || token.startsWith("keyword:") || token.startsWith("regexp:")) {
    return null;
  }

  const raw = token.replace(/^(?:domain|full):/, "");
  const value = normalizeDomain(raw);
  if (!value) return null;
  return {
    value,
    attributes: new Set(metadata.filter((part) => part.startsWith("@"))),
    affiliations: metadata.filter((part) => part.startsWith("&")).map((part) => part.slice(1)),
  };
}

function matchesAttributes(rule, filters) {
  return filters.every((filter) => {
    if (filter.startsWith("@-")) return !rule.attributes.has(`@${filter.slice(2)}`);
    return rule.attributes.has(filter);
  });
}
