// Copyright 2026 Defense Unicorns
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Defense-Unicorns-Commercial

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { test } from "node:test";
import {
  HERE,
  buildConfig,
  compareVersions,
  createMockServer,
  discover,
  loadFixtures,
  parsePins,
  renderDashboard,
} from "./poc.mjs";

async function inputs() {
  return {
    fixtures: await loadFixtures(),
    pins: parsePins(await readFile(join(HERE, "demo-pins.yaml"), "utf8")),
  };
}

async function withMock(run) {
  const { fixtures, pins } = await inputs();
  const server = createMockServer(fixtures);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run({ fixtures, pins, url: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
}

const fixtureFetcher = fixtures => async url => {
  const packages = fixtures.families.flatMap(f => f.members);
  const member = packages.find(m => url.endsWith(`/releases/${m.packageName}`));
  return new Response(JSON.stringify({ releases: member.tags.map(version => ({ version })) }));
};

test("end-to-end discovery uses the HTTP mock and prepares bounded Renovate updates", async () => {
  await withMock(async ({ fixtures, pins, url }) => {
    const snapshot = await discover(fixtures, pins, url);
    const istio = snapshot.families.find(f => f.id === "istio");
    const authservice = snapshot.families.find(f => f.id === "authservice");
    assert.equal(istio.newestShared, "1.31.2");
    assert.deepEqual(
      istio.members.map(m => m.targetTag),
      ["1.31.2-distroless", "1.31.2-fips", "v1.31.2"],
    );
    assert.equal(authservice.status, "No shared upgrade");
    assert(authservice.members.every(m => m.targetTag === m.currentTag));
    const config = buildConfig(snapshot, { mockUrl: url });
    assert.equal(config.dryRun, "full");
    assert.equal(config.requireConfig, "ignored");
    assert.deepEqual(
      config.repositories.map(r => r.repository),
      ["joelmccoy/uds-core"],
    );
    const repo = config.repositories[0];
    assert.deepEqual(repo.enabledManagers, ["custom.regex"]);
    assert.equal(repo.automerge, false);
    assert.equal(repo.packageRules.length, 7);
    for (const family of snapshot.families) {
      for (const member of family.members) {
        const rule = repo.packageRules.find(r => r.matchPackageNames?.includes(member.packageName));
        const predicate = new RegExp(rule.allowedVersions.slice(1, -1));
        assert(predicate.test(member.targetTag));
        assert(!predicate.test("99.99.99"));
      }
    }
    const upstream = repo.packageRules.find(
      r => r.matchPackageNames?.[0] === "mock.upstream.invalid/istio/pilot",
    );
    assert(!new RegExp(upstream.allowedVersions.slice(1, -1)).test("1.31.3-distroless"));
  });
});

test("full intersection does not choose the minimum of latest tags", async () => {
  const { fixtures, pins } = await inputs();
  fixtures.families[0].members[0].tags = ["1.31.1-distroless", "1.31.3-distroless"];
  const snapshot = await discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures));
  assert.equal(snapshot.families[0].newestShared, "1.31.1");
});

test("a downgrade freezes current tags", async () => {
  const { fixtures, pins } = await inputs();
  pins.set("mock.upstream.invalid/istio/pilot", "1.31.3-distroless");
  const snapshot = await discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures));
  assert.equal(snapshot.families[0].status, "Downgrade skipped");
  assert(snapshot.families[0].members.every(m => m.targetTag === m.currentTag));
});

test("empty shared sets still emit frozen constraints", async () => {
  const { fixtures, pins } = await inputs();
  fixtures.families[0].members[2].tags = ["v1.30.0"];
  const snapshot = await discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures));
  assert.equal(snapshot.families[0].newestShared, null);
  assert(snapshot.families[0].members.every(m => m.targetTag === m.currentTag));
  assert.equal(buildConfig(snapshot).repositories[0].packageRules.length, 7);
});

test("lookup failure aborts discovery rather than generating partial constraints", async () => {
  const { fixtures, pins } = await inputs();
  await assert.rejects(
    discover(
      fixtures,
      pins,
      "http://mock",
      async () => new Response("unavailable", { status: 503 }),
    ),
    /lookup failed/,
  );
});

test("rejects untracked pins, duplicate pins, ambiguous tags, and non-fork targets", async () => {
  const { fixtures, pins } = await inputs();
  pins.set("mock.upstream.invalid/unmapped", "1.0.0");
  await assert.rejects(
    discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures)),
    /lack a mapping/,
  );
  assert.throws(
    () => parsePins("# renovate-poc: x\nimage: x:1.0.0\n# renovate-poc: x\nimage: x:1.0.1"),
    /Duplicate/,
  );
  pins.delete("mock.upstream.invalid/unmapped");
  fixtures.families[0].members[0].tags.push("1.31.2-distroless");
  await assert.rejects(
    discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures)),
    /Ambiguous/,
  );
  assert.throws(
    () => buildConfig({ mocked: true }, { repository: "defenseunicorns/uds-core" }),
    /restricted/,
  );
  assert.throws(
    () => buildConfig({ mocked: true }, { mockUrl: "https://real-registry.example" }),
    /local mock/,
  );
});

test("dashboard separates current/latest/target, mocks, failures, and PR state", async () => {
  const { fixtures, pins } = await inputs();
  const snapshot = await discover(fixtures, pins, "http://mock", fixtureFetcher(fixtures));
  const body = renderDashboard(snapshot, [
    {
      number: 123,
      html_url: "https://github.com/joelmccoy/uds-core/pull/123",
      head: { ref: "renovate-poc/aligned-images" },
      draft: false,
    },
  ]);
  assert.match(body, /All publisher availability is mocked/);
  assert.match(body, /Current pin \| Latest mock tag \| Selected tag/);
  assert.match(body, /1\.31\.3-distroless/);
  assert.match(body, /\[#123\]/);
  assert.match(body, /not test or merge readiness/);
  assert.match(renderDashboard(undefined, [], { failed: true }), /Latest attempt failed/);
});

test("CLI runs through a symlink and renders a failed preview without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renovate-poc-test-"));
  try {
    const entry = join(directory, "entry.mjs");
    await symlink(join(HERE, "poc.mjs"), entry);
    await promisify(execFile)(process.execPath, [entry, "dashboard"], {
      env: { ...process.env, POC_APPLY: "false", POC_OUT_DIR: directory },
    });
    assert.match(await readFile(join(directory, "dashboard.md"), "utf8"), /Latest attempt failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stable version comparison is numeric and rejects unsupported versions", () => {
  assert(compareVersions("1.31.10", "1.31.2") > 0);
  assert.throws(() => compareVersions("latest", "1.0.0"), /stable X.Y.Z/);
});
