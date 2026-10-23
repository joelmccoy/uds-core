// Copyright 2026 Defense Unicorns
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY = "joelmccoy/uds-core";
export const PIN_FILE = "scripts/renovate/poc/demo-pins.yaml";
export const ISSUE_MARKER = "<!-- uds-image-alignment-poc -->";
export const HERE = dirname(fileURLToPath(import.meta.url));
export const PIN_PATTERN =
  "# renovate-poc: (?<depName>[^\\r\\n]+)\\r?\\n[ \\t]*image: [^\\s]+:(?<currentValue>[^\\s]+)";

export function compareVersions(a, b) {
  const parse = value => {
    assert.match(value, /^\d+\.\d+\.\d+$/, "POC supports stable X.Y.Z versions only");
    const parts = value.split(".").map(Number);
    assert(parts.every(Number.isSafeInteger), "Version component is too large");
    return parts;
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function parsePins(source) {
  const pins = new Map();
  for (const match of source.matchAll(new RegExp(PIN_PATTERN, "g"))) {
    const { depName, currentValue } = match.groups;
    assert(!pins.has(depName), `Duplicate demo pin: ${depName}`);
    pins.set(depName, currentValue);
  }
  assert(pins.size > 0, "No demo image pins found");
  return pins;
}

export async function loadFixtures() {
  const fixtures = JSON.parse(await readFile(join(HERE, "fixtures.json"), "utf8"));
  assert.equal(fixtures.mocked, true, "This POC accepts mocked data only");
  return fixtures;
}

export function createMockServer(fixtures) {
  const packages = new Map(
    fixtures.families.flatMap(family =>
      family.members.map(member => [member.packageName, member.tags]),
    ),
  );
  return createServer((request, response) => {
    const path = new URL(request.url, "http://mock.invalid").pathname;
    response.setHeader("Content-Type", "application/json");
    if (path === "/healthz") return response.end('{"mocked":true}');
    const tags = packages.get(path.replace(/^\/releases\//, ""));
    if (!path.startsWith("/releases/") || !tags) {
      response.writeHead(404);
      return response.end('{"error":"Unknown mock package"}');
    }
    response.end(JSON.stringify({ releases: tags.map(version => ({ version })) }));
  });
}

export async function discover(fixtures, pins, mockUrl, fetcher = fetch) {
  const families = [];
  const seen = new Set();
  for (const family of fixtures.families) {
    const members = [];
    for (const member of family.members) {
      assert(!seen.has(member.packageName), `Duplicate mapping: ${member.packageName}`);
      seen.add(member.packageName);
      const currentTag = pins.get(member.packageName);
      assert(currentTag, `Missing pin: ${member.packageName}`);
      const pattern = new RegExp(member.tagPattern);
      const currentVersion = pattern.exec(currentTag)?.groups?.version;
      assert(currentVersion, `Current tag does not match mapping: ${member.packageName}`);
      const response = await fetcher(`${mockUrl}/releases/${member.packageName}`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert(response.ok, `Mock lookup failed (${response.status}): ${member.packageName}`);
      const data = await response.json();
      assert(Array.isArray(data.releases), "Invalid mock release response");
      const versions = new Map();
      for (const release of data.releases) {
        assert.equal(typeof release.version, "string");
        const version = pattern.exec(release.version)?.groups?.version;
        if (!version) continue;
        compareVersions(version, version);
        assert(!versions.has(version), `Ambiguous mock tag: ${member.packageName}:${version}`);
        versions.set(version, release.version);
      }
      const sorted = [...versions.keys()].sort(compareVersions);
      members.push({
        flavor: member.flavor,
        packageName: member.packageName,
        currentTag,
        currentVersion,
        latestTag: versions.get(sorted.at(-1)) ?? "No matching tag",
        versions,
      });
    }
    assert(members.length > 0, `Empty family: ${family.id}`);
    const shared = [...members[0].versions.keys()]
      .filter(version => members.every(member => member.versions.has(version)))
      .sort(compareVersions);
    const newestShared = shared.at(-1) ?? null;
    const downgrade =
      newestShared !== null &&
      members.some(member => compareVersions(newestShared, member.currentVersion) < 0);
    const advances =
      newestShared !== null &&
      !downgrade &&
      members.some(member => compareVersions(newestShared, member.currentVersion) > 0);
    families.push({
      id: family.id,
      newestShared,
      status: downgrade
        ? "Downgrade skipped"
        : advances
          ? "Shared upgrade available"
          : newestShared
            ? "No shared upgrade"
            : "No shared release",
      members: members.map(({ versions, ...member }) => ({
        ...member,
        targetTag: newestShared && !downgrade ? versions.get(newestShared) : member.currentTag,
      })),
    });
  }
  assert.equal(seen.size, pins.size, "Some demo pins lack a mapping");
  return { mocked: true, observedAt: new Date().toISOString(), families };
}

export function buildConfig(
  snapshot,
  {
    repository = REPOSITORY,
    baseBranch = "main",
    mockUrl = "http://127.0.0.1:8765",
    apply = false,
  } = {},
) {
  assert.equal(repository, REPOSITORY, "POC writes are restricted to joelmccoy/uds-core");
  const url = new URL(mockUrl);
  assert(["127.0.0.1", "host.docker.internal"].includes(url.hostname), "Use the local mock only");
  assert.equal(url.protocol, "http:");
  assert.equal(snapshot.mocked, true);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    platform: "github",
    onboarding: false,
    requireConfig: "ignored",
    forkProcessing: "enabled",
    platformCommit: "enabled",
    ...(apply ? {} : { dryRun: "full" }),
    internalHostAccess: "block",
    hostRules: [{ matchHost: `${url.origin}/`, allowInternal: true, abortOnError: true }],
    repositories: [
      {
        repository,
        baseBranchPatterns: [baseBranch],
        enabledManagers: ["custom.regex"],
        branchPrefix: "renovate-poc/",
        dependencyDashboard: false,
        automerge: false,
        prCreation: "immediate",
        prHourlyLimit: 0,
        prConcurrentLimit: 0,
        vulnerabilityAlerts: { enabled: false },
        prBodyNotes: [
          "POC only: all image availability is mocked. Only demo pins change; production images are untouched.",
        ],
        customDatasources: {
          "mock-images": {
            defaultRegistryUrlTemplate: `${url.origin}/releases/{{{packageName}}}`,
            format: "json",
          },
        },
        customManagers: [
          {
            customType: "regex",
            managerFilePatterns: ["/^scripts\\/renovate\\/poc\\/demo-pins\\.yaml$/"],
            matchStrings: [PIN_PATTERN],
            datasourceTemplate: "custom.mock-images",
            versioningTemplate:
              "regex:^v?(?<major>\\d+)\\.(?<minor>\\d+)\\.(?<patch>\\d+)(?:-distroless|-fips)?$",
          },
        ],
        packageRules: [
          {
            matchManagers: ["custom.regex"],
            groupName: "Mocked application images",
            groupSlug: "aligned-images",
          },
          ...snapshot.families.flatMap(family =>
            family.members.map(member => ({
              matchFileNames: [PIN_FILE],
              matchPackageNames: [member.packageName],
              allowedVersions: `/^${escape(member.targetTag)}$/`,
            })),
          ),
        ],
      },
    ],
  };
}

const cell = value =>
  String(value)
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ");

export function renderDashboard(snapshot, pulls = [], { failed = false, runUrl = "" } = {}) {
  const lines = [
    ISSUE_MARKER,
    "# Image alignment POC",
    "",
    "**All publisher availability is mocked. No private registry credentials are used.**",
    "",
    failed
      ? "**Latest attempt failed. No fresh availability is claimed.**"
      : `Observed: ${snapshot.observedAt}. Current means demo pins, not deployed images.`,
    ...(runUrl ? [`[Workflow run](${runUrl})`] : []),
    "",
    "| Component | Flavor | Current pin | Latest mock tag | Selected tag | Shared release | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const family of snapshot?.families ?? []) {
    for (const member of family.members) {
      lines.push(
        `| ${[
          family.id,
          member.flavor,
          member.currentTag,
          member.latestTag,
          member.targetTag,
          family.newestShared ?? "None",
          family.status,
        ]
          .map(cell)
          .join(" | ")} |`,
      );
    }
  }
  lines.push(
    "",
    "## Open POC update PRs",
    "",
    "This POC reports PR state only, not test or merge readiness.",
    "",
    "| PR | Branch | State |",
    "| --- | --- | --- |",
  );
  for (const pull of pulls.filter(pr => pr.head.ref.startsWith("renovate-poc/"))) {
    lines.push(
      `| [#${pull.number}](${pull.html_url}) | ${cell(pull.head.ref)} | ${pull.draft ? "Draft" : "Open"} |`,
    );
  }
  if (!pulls.some(pr => pr.head.ref.startsWith("renovate-poc/"))) {
    lines.push("| None | No POC update PR found | Preview mode or no update yet |");
  }
  return `${lines.join("\n")}\n`;
}

export async function github(path, { method = "GET", body, token = process.env.GH_TOKEN } = {}) {
  assert(token, "Set GH_TOKEN to write the dashboard");
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `GitHub ${method} ${path.split("?")[0]} failed: ${response.status}`);
  return response.json();
}

export async function paginate(path) {
  const result = [];
  for (let page = 1; ; page++) {
    const data = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    result.push(...data);
    if (data.length < 100) return result;
  }
}

export async function publishDashboard(body) {
  const issues = await paginate("issues?state=open");
  const matches = issues.filter(issue => !issue.pull_request && issue.body?.includes(ISSUE_MARKER));
  assert(matches.length <= 1, "Multiple POC dashboards found; reconcile them before continuing");
  return matches.length
    ? github(`issues/${matches[0].number}`, { method: "PATCH", body: { body } })
    : github("issues", { method: "POST", body: { title: "Image alignment POC (mocked)", body } });
}

async function main(command) {
  const out = process.env.POC_OUT_DIR ? resolve(process.env.POC_OUT_DIR) : join(HERE, "out");
  const mockUrl = process.env.POC_MOCK_URL ?? "http://127.0.0.1:8765";
  if (command === "serve") {
    const server = createMockServer(await loadFixtures());
    const port = Number(process.env.POC_MOCK_PORT ?? 8765);
    server.listen(port, "0.0.0.0", () => console.log(`Mock publisher API listening on ${port}`));
    return;
  }
  await mkdir(out, { recursive: true });
  if (command === "prepare") {
    const fixtures = await loadFixtures();
    const pins = parsePins(await readFile(join(HERE, "demo-pins.yaml"), "utf8"));
    const snapshot = await discover(fixtures, pins, mockUrl);
    const config = buildConfig(snapshot, {
      repository: process.env.POC_REPOSITORY ?? REPOSITORY,
      baseBranch: process.env.POC_BASE_BRANCH ?? "main",
      mockUrl: process.env.POC_RENOVATE_MOCK_URL ?? mockUrl,
      apply: process.env.POC_APPLY === "true",
    });
    await writeFile(join(out, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    await writeFile(join(out, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(out, "dashboard.md"), renderDashboard(snapshot));
    console.log(
      snapshot.families.map(f => `${f.id}: ${f.newestShared ?? "none"} (${f.status})`).join("\n"),
    );
  } else if (command === "dashboard") {
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(join(out, "snapshot.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const apply = process.env.POC_APPLY === "true";
    const pulls = apply ? await paginate("pulls?state=open") : [];
    const body = renderDashboard(snapshot, pulls, {
      failed: process.env.POC_FAILED === "true" || !snapshot,
      runUrl: process.env.POC_RUN_URL ?? "",
    });
    await writeFile(join(out, "dashboard.md"), body);
    if (apply) console.log((await publishDashboard(body)).html_url);
    else console.log(`Preview written to ${join(out, "dashboard.md")}`);
  } else {
    throw new Error("Usage: node poc.mjs serve|prepare|dashboard");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
