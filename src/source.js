import { gunzipSync } from "node:zlib";
import { loadDomainListFromEntries } from "./domain-list.js";

export async function loadRemoteDomainList(url, onStatus = () => {}) {
  onStatus(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: {
      Accept: "application/gzip",
      "User-Agent": "ru-ip-routes",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Unable to download v2fly data: HTTP ${response.status} ${response.statusText}`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  onStatus(`Downloaded ${formatBytes(compressed.length)}; unpacking archive in memory`);
  const entries = extractDataFiles(gunzipSync(compressed));
  if (entries.size === 0) throw new Error("Downloaded v2fly archive contains no data files");
  onStatus(`Loaded ${entries.size} v2fly data files`);
  return loadDomainListFromEntries(entries);
}

export async function loadRemoteText(url, onStatus = () => {}) {
  onStatus(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "ru-ip-routes" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Unable to download source data: HTTP ${response.status} ${response.statusText}`);
  }
  const content = await response.text();
  onStatus(`Downloaded ${formatBytes(Buffer.byteLength(content))}`);
  return content;
}

export function extractDataFiles(archive) {
  const entries = new Map();
  let offset = 0;
  let pendingPath = null;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const sizeText = readTarString(header, 124, 136).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid TAR entry size");

    const type = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 500);
    const shortName = readTarString(header, 0, 100);
    const headerPath = prefix ? `${prefix}/${shortName}` : shortName;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("Truncated TAR archive");
    const body = archive.subarray(dataStart, dataEnd);

    if (type === "L") {
      pendingPath = readNullTerminated(body);
    } else if (type === "x") {
      pendingPath = readPaxPath(body) ?? pendingPath;
    } else if (type === "0" || type === "\0") {
      const entryPath = pendingPath ?? headerPath;
      const match = entryPath.match(/(?:^|\/)data\/([^/]+)$/);
      if (match) entries.set(match[1], body.toString("utf8"));
      pendingPath = null;
    } else {
      pendingPath = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readTarString(buffer, start, end) {
  return readNullTerminated(buffer.subarray(start, end));
}

function readNullTerminated(buffer) {
  const nullIndex = buffer.indexOf(0);
  return buffer.subarray(0, nullIndex === -1 ? buffer.length : nullIndex).toString("utf8");
}

function readPaxPath(buffer) {
  const content = buffer.toString("utf8");
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(content.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = content.slice(space + 1, offset + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return null;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
