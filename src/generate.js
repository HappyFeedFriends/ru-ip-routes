#!/usr/bin/env node

import dns from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDomainList, parseManualEntries } from "./domain-list.js";
import { collapseIpv4Cidrs, isIpInCidrs, isPublicIpv4, ipv4ToInt, parseCidr, subtractIpv4Cidrs } from "./ipv4.js";
import { loadRemoteDomainList, loadRemoteText } from "./source.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function generate(options) {
  const log = options.log ?? console.log;
  const startedAt = Date.now();

  log(`[1/8] Loading v2fly domain data (${options.dataDirectory ? "local directory" : "HTTPS"})`);
  const categories = await readSimpleList(options.categoriesFile);
  const include = parseManualEntries(await readFile(options.includeFile, "utf8"), { allowCategories: true });
  const exclude = parseManualEntries(await readFile(options.excludeFile, "utf8"));
  const domainList = options.dataDirectory
    ? await loadDomainList(options.dataDirectory)
    : await loadRemoteDomainList(options.sourceUrl, (message) => log(`      ${message}`));

  log(`[2/8] Expanding ${categories.length + include.categories.length} root categories`);
  const rules = [];
  for (const category of [...categories, ...include.categories]) {
    rules.push(...await domainList.expand(category));
  }

  const excludedDomains = new Set(exclude.domains);
  const domains = new Set([
    ...rules.map((rule) => rule.value),
    ...include.domains,
  ].filter((domain) => !isExcludedDomain(domain, excludedDomains)));

  log(`      Collected ${domains.size} unique resolvable domain names`);
  log(`[3/8] Resolving domains through ${options.dnsServers.length} DNS providers`);
  const resolved = await resolveDomains([...domains], options, (progress) => {
    log(`      DNS ${progress.processed}/${progress.total} (${progress.percent}%) — ${progress.resolvedDomains} domains resolved, ${progress.ips} unique IPs`);
  });

  log("[4/8] Loading Russian GeoIP networks");
  const geoipText = await loadRemoteText(options.geoipUrl, (message) => log(`      ${message}`));
  const rawGeoipCidrs = parseGeoipIpv4(geoipText);
  log(`      Collected ${rawGeoipCidrs.length} IPv4 prefixes from GeoIP`);

  log("[5/8] Applying include/exclude rules");
  const excludedCidrs = [...exclude.ips, ...exclude.cidrs];
  const parsedExcludedCidrs = excludedCidrs.map(parseCidr);
  include.cidrs.forEach(parseCidr);
  const sortedServiceIps = [...new Set([...resolved.ips, ...include.ips])]
    .filter(isPublicIpv4)
    .filter((ip) => !isIpInCidrs(ip, parsedExcludedCidrs))
    .sort((a, b) => ipv4ToInt(a) - ipv4ToInt(b));

  if (sortedServiceIps.length === 0) throw new Error("Generation produced no public service IPv4 addresses");
  const successRate = domains.size === 0 ? 1 : resolved.resolvedDomains / domains.size;
  if (successRate < options.minSuccessRate) {
    throw new Error(`Only ${(successRate * 100).toFixed(1)}% of domains resolved; refusing to replace outputs`);
  }

  const manualCidrs = include.cidrs.filter(isPublicCidr);
  const serviceCidrs = subtractIpv4Cidrs([
    ...sortedServiceIps.map((ip) => `${ip}/32`),
    ...manualCidrs,
  ], excludedCidrs);
  const geoipCidrs = subtractIpv4Cidrs(rawGeoipCidrs.filter(isPublicCidr), excludedCidrs);

  log("[6/8] Combining service and GeoIP routes");
  const combinedCidrs = collapseIpv4Cidrs([...serviceCidrs, ...geoipCidrs]);

  log("[7/8] Building GeoIP-only AmneziaVPN configurations");
  const amneziaFullCidrs = geoipCidrs;
  const amneziaLiteCidrs = selectLargestCidrs(geoipCidrs, options.liteRouteLimit);
  const liteCoverage = calculateAddressCoverage(amneziaLiteCidrs, geoipCidrs);
  log(`      Full: ${amneziaFullCidrs.length} routes; mobile lite: ${amneziaLiteCidrs.length} routes (${formatPercent(liteCoverage)} of GeoIP address space)`);

  log(`[8/8] Writing route lists and AmneziaVPN configurations`);
  await mkdir(options.outputDirectory, { recursive: true });
  await atomicWrite(path.join(options.outputDirectory, "ru-services-ipv4.txt"), `${sortedServiceIps.join("\n")}\n`);
  await atomicWrite(path.join(options.outputDirectory, "ru-services-cidr.txt"), `${serviceCidrs.join("\n")}\n`);
  await atomicWrite(path.join(options.outputDirectory, "ru-geoip-cidr.txt"), `${geoipCidrs.join("\n")}\n`);
  await atomicWrite(path.join(options.outputDirectory, "ru-combined-cidr.txt"), `${combinedCidrs.join("\n")}\n`);
  await atomicWrite(path.join(options.outputDirectory, "amnezia-full.json"), toAmneziaJson(amneziaFullCidrs));
  await atomicWrite(path.join(options.outputDirectory, "amnezia-lite.json"), toAmneziaJson(amneziaLiteCidrs));
  log(`      Done in ${formatDuration(Date.now() - startedAt)}: ${options.outputDirectory}`);

  return {
    domains: domains.size,
    resolvedDomains: resolved.resolvedDomains,
    serviceIps: sortedServiceIps.length,
    serviceCidrs: serviceCidrs.length,
    geoipCidrs: geoipCidrs.length,
    combinedCidrs: combinedCidrs.length,
    amneziaFullRoutes: amneziaFullCidrs.length,
    amneziaLiteRoutes: amneziaLiteCidrs.length,
    amneziaLiteCoverage: liteCoverage,
  };
}

async function resolveDomains(domains, options, onProgress = () => {}) {
  const providers = createResolvers(options.dnsServers);
  const ips = new Set();
  let resolvedDomains = 0;
  let processed = 0;
  let cursor = 0;
  const progressStep = Math.max(1, Math.ceil(domains.length / 20));
  let nextProgress = progressStep;

  async function worker() {
    while (cursor < domains.length) {
      const domain = domains[cursor++];
      const results = await Promise.allSettled(providers.map((resolver) => resolver.resolve4(domain)));
      const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (addresses.length > 0) resolvedDomains += 1;
      for (const address of addresses) ips.add(address);
      processed += 1;
      if (processed >= nextProgress || processed === domains.length) {
        onProgress({
          processed,
          total: domains.length,
          percent: Math.round(processed / domains.length * 100),
          resolvedDomains,
          ips: ips.size,
        });
        while (nextProgress <= processed) nextProgress += progressStep;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, domains.length) }, worker));
  return { ips, resolvedDomains };
}

function createResolvers(servers) {
  return servers.map((server) => {
    if (server === "system") return dns;
    const resolver = new dns.Resolver({ timeout: 5_000, tries: 2 });
    resolver.setServers([server]);
    return resolver;
  });
}

function isExcludedDomain(domain, exclusions) {
  for (const excluded of exclusions) {
    if (domain === excluded || domain.endsWith(`.${excluded}`)) return true;
  }
  return false;
}

function selectLargestCidrs(cidrs, limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Amnezia lite route limit must be a positive integer, got: ${limit}`);
  }

  return cidrs
    .map((cidr) => ({ cidr, ...parseCidr(cidr) }))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ cidr }) => cidr);
}

function calculateAddressCoverage(selectedCidrs, allCidrs) {
  const selectedAddresses = countCidrAddresses(selectedCidrs);
  const allAddresses = countCidrAddresses(allCidrs);
  return allAddresses === 0 ? 1 : selectedAddresses / allAddresses;
}

function countCidrAddresses(cidrs) {
  return cidrs.reduce((total, cidr) => {
    const { start, end } = parseCidr(cidr);
    return total + end - start + 1;
  }, 0);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function toAmneziaJson(cidrs) {
  return `${JSON.stringify(cidrs.map((hostname) => ({ hostname, ip: "" })), null, 2)}\n`;
}

function parseGeoipIpv4(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.split("#", 1)[0].trim())
    .filter((line) => line && !line.includes(":"))
    .filter((line) => {
      try {
        parseCidr(line);
        return true;
      } catch {
        return false;
      }
    });
}

function isPublicCidr(value) {
  try {
    const { start, end } = parseCidr(value);
    return isPublicIpv4(numberToIpv4(start)) && isPublicIpv4(numberToIpv4(end));
  } catch {
    return false;
  }
}

function numberToIpv4(value) {
  return [
    Math.floor(value / 0x1000000),
    Math.floor(value / 0x10000) % 256,
    Math.floor(value / 0x100) % 256,
    value % 256,
  ].join(".");
}

async function readSimpleList(filePath) {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.split("#", 1)[0].trim())
    .filter(Boolean);
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key ?? ""}`);
    values.set(key.slice(2), value);
  }

  const envServers = process.env.DNS_SERVERS ?? "77.88.8.8,1.1.1.1";
  return {
    dataDirectory: values.has("data") ? path.resolve(values.get("data")) : null,
    sourceUrl: values.get("source-url") ?? process.env.DOMAIN_LIST_URL ?? "https://codeload.github.com/v2fly/domain-list-community/tar.gz/refs/heads/master",
    geoipUrl: values.get("geoip-url") ?? process.env.GEOIP_URL ?? "https://raw.githubusercontent.com/v2fly/geoip/release/text/ru.txt",
    categoriesFile: path.resolve(values.get("categories") ?? path.join(projectRoot, "config/categories.txt")),
    includeFile: path.resolve(values.get("include") ?? path.join(projectRoot, "config/include.txt")),
    excludeFile: path.resolve(values.get("exclude") ?? path.join(projectRoot, "config/exclude.txt")),
    outputDirectory: path.resolve(values.get("output") ?? path.join(projectRoot, "output")),
    dnsServers: (values.get("dns-servers") ?? envServers).split(",").map((value) => value.trim()).filter(Boolean),
    concurrency: Number(values.get("concurrency") ?? process.env.DNS_CONCURRENCY ?? 40),
    minSuccessRate: Number(values.get("min-success-rate") ?? process.env.MIN_SUCCESS_RATE ?? 0.2),
    liteRouteLimit: Number(values.get("lite-route-limit") ?? process.env.AMNEZIA_LITE_ROUTE_LIMIT ?? 1000),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const stats = await generate(parseArguments(process.argv.slice(2)));
    console.log(`Processed ${stats.domains} domains; wrote ${stats.serviceIps} service IPs, ${stats.combinedCidrs} combined CIDRs, ${stats.amneziaFullRoutes} full Amnezia routes, and ${stats.amneziaLiteRoutes} mobile routes.`);
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

export { parseArguments, selectLargestCidrs, toAmneziaJson };
