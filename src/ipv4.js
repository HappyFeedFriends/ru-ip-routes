const MAX_IPV4 = 0xffffffff;

export function ipv4ToInt(value) {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    throw new Error(`Invalid IPv4 address: ${value}`);
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new Error(`Invalid IPv4 address: ${value}`);
  }

  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
}

export function intToIpv4(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_IPV4) {
    throw new Error(`Invalid IPv4 integer: ${value}`);
  }

  return [
    Math.floor(value / 0x1000000),
    Math.floor(value / 0x10000) % 256,
    Math.floor(value / 0x100) % 256,
    value % 256,
  ].join(".");
}

export function parseCidr(value) {
  const [address, rawPrefix] = value.trim().split("/");
  const prefix = rawPrefix === undefined ? 32 : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid IPv4 CIDR: ${value}`);
  }

  const ip = ipv4ToInt(address);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return { start, end: start + size - 1, prefix };
}

export function isPublicIpv4(value) {
  let ip;
  try {
    ip = ipv4ToInt(value);
  } catch {
    return false;
  }

  const reserved = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ];

  return !reserved.some((cidr) => {
    const range = parseCidr(cidr);
    return ip >= range.start && ip <= range.end;
  });
}

export function isIpInCidrs(value, cidrs) {
  const ip = ipv4ToInt(value);
  return cidrs.some(({ start, end }) => ip >= start && ip <= end);
}

export function collapseIpv4(addresses) {
  const sorted = [...new Set(addresses.map(ipv4ToInt))].sort((a, b) => a - b);
  const ranges = [];

  for (const ip of sorted) {
    const previous = ranges.at(-1);
    if (previous && ip === previous.end + 1) {
      previous.end = ip;
    } else {
      ranges.push({ start: ip, end: ip });
    }
  }

  return ranges.flatMap(({ start, end }) => rangeToCidrs(start, end));
}

export function collapseIpv4Cidrs(cidrs) {
  return mergeRanges(cidrs.map(parseCidr)).flatMap(({ start, end }) => rangeToCidrs(start, end));
}

export function subtractIpv4Cidrs(cidrs, exclusions) {
  const sourceRanges = mergeRanges(cidrs.map(parseCidr));
  const excludedRanges = mergeRanges(exclusions.map(parseCidr));
  const result = [];

  for (const source of sourceRanges) {
    let cursor = source.start;
    for (const excluded of excludedRanges) {
      if (excluded.end < cursor) continue;
      if (excluded.start > source.end) break;
      if (excluded.start > cursor) result.push({ start: cursor, end: excluded.start - 1 });
      cursor = Math.max(cursor, excluded.end + 1);
      if (cursor > source.end) break;
    }
    if (cursor <= source.end) result.push({ start: cursor, end: source.end });
  }

  return result.flatMap(({ start, end }) => rangeToCidrs(start, end));
}

export function rangeToCidrs(start, end) {
  const result = [];
  let current = start;

  while (current <= end) {
    let size = current === 0 ? 2 ** 32 : 2 ** countTrailingZeroBits(current);
    const remaining = end - current + 1;
    while (size > remaining) size /= 2;

    const prefix = 32 - Math.log2(size);
    result.push(`${intToIpv4(current)}/${prefix}`);
    current += size;
  }

  return result;
}

function mergeRanges(ranges) {
  const sorted = ranges
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }

  return merged;
}

function countTrailingZeroBits(value) {
  let count = 0;
  let current = value;
  while (count < 32 && current % 2 === 0) {
    count += 1;
    current /= 2;
  }
  return count;
}
