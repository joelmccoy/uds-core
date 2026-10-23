# Fork-only image alignment POC

This proof of concept (POC) selects the newest application version shared by mocked upstream, Registry1, and Chainguard tags. All GitHub writes stay in `joelmccoy/uds-core`; update pull requests (PRs) change only [demo-pins.yaml](demo-pins.yaml).

## Mocked example

The local HTTP server serves [fixtures.json](fixtures.json), not live registry data. These are the available application versions after removing tag prefixes and suffixes:

| Component   | Upstream               | Registry1      | Chainguard (`unicorn`) | Result                   |
| ----------- | ---------------------- | -------------- | ---------------------- | ------------------------ |
| Istio       | 1.31.1, 1.31.2, 1.31.3 | 1.31.1, 1.31.2 | 1.31.1, 1.31.2         | Upgrade 1.31.1 to 1.31.2 |
| authservice | 1.1.8, 1.1.9           | 1.1.8          | 1.1.8                  | Freeze at 1.1.8          |

Istio stays below upstream 1.31.3 because the other publishers lack it. Selected tags retain their publisher format: `1.31.2-distroless`, `1.31.2-fips`, and `v1.31.2`.

Renovate uses a custom mock datasource, not real Docker lookups. The generated configuration ignores production repository configuration. You need no private registry credentials. This POC does not verify real flavor compatibility, architectures, or digests, and it has no schedule or automatic merging.

## Walk-through

Run the tests from the repository root with Node.js 24; you do not need `npm install`:

```bash
node --test scripts/renovate/poc/poc.test.mjs
```

To run the manual GitHub Action in your fork:

1. **Merge the implementation PR into `main`.** GitHub requires a new `workflow_dispatch` workflow to exist on the default branch before you can dispatch it. The POC also requires `main` for Renovate runs; implementation PR runs test only.
2. **Preview.** In `joelmccoy/uds-core`, open **Actions** > **Renovate image alignment POC** > **Run workflow**. Select `main` and leave `apply` unchecked. Review the workflow summary and Renovate logs. Preview creates no update PR or dashboard issue.
3. **Apply.** Run the same workflow with `apply` checked. Expect a grouped update PR on a `renovate-poc/` branch that changes only the Istio demo pins, plus a dashboard issue showing current, latest, and selected mock tags. authservice stays at 1.1.8. The dashboard reports PR state, not test or merge readiness.

## Write permissions

The workflow falls back to the built-in `GITHUB_TOKEN`. Use a GitHub App if token permissions prevent writes or you need downstream workflows to run from the generated PR.

Install the App only on `joelmccoy/uds-core`, with **Contents**, **Pull requests**, and **Issues** repository permissions set to **Read and write**. Set repository variable `RENOVATE_POC_APP_ID` and repository secret `RENOVATE_POC_APP_PRIVATE_KEY`; the workflow then prefers the App token.

## Related documentation

Reference these files for the implementation details:

- [POC script](poc.mjs) - mock server, version selection, isolated configuration, and dashboard.
- [POC workflow](../../../.github/workflows/renovate-poc.yaml) - dispatch inputs and token handling.
