# Security policy

We take security reports seriously. `mcp-devtools` runs locally and proxies the wire-level protocol between an MCP client and server — both of which often carry credentials, tokens, and private data. A defect here can leak more than just our own state.

## Reporting a vulnerability

**Do not open a public issue.** Instead, use one of the channels below.

- **Preferred — GitHub private vulnerability reporting.** Visit the [Security tab](https://github.com/adityachilka1/mcp-devtools/security) of this repository and click *Report a vulnerability*. This creates a private advisory that only the maintainers can see.
- **Backup — email.** `aditya@rapidcircuitry.com` with subject line `[security] mcp-devtools`. Include reproduction steps. We acknowledge within 72 hours and aim to ship a patch within 14 days of triage.

When you report, please include:

- The affected version (`mcp-devtools --version`).
- A minimal reproducer — ideally a `.mcptrace` file plus the upstream server command that triggered the issue.
- The class of issue (information disclosure, code execution, denial of service, etc.).
- Whether you've already disclosed it elsewhere and any preferred credit / public name.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ |
| < 0.1   | ❌ — please upgrade |

We patch the latest minor release in place. Older minors receive backports only for critical vulnerabilities (CVSS ≥ 7.0).

## What counts as a vulnerability

- Any way a remote or untrusted MCP server can read, modify, or delete files outside the inspector's own working set.
- Any way the inspector UI exposes recorded session data to a third party via the network.
- Any code execution path from a malformed JSON-RPC frame.
- Any credential or token leakage in the on-disk `.mcptrace` artifacts beyond what the user explicitly recorded.

## What doesn't

- Bugs that require the attacker to already have full local access to the user's machine.
- Spoofing or social-engineering of an MCP server the user explicitly invoked.
- Issues only reproducible on unsupported Node versions (we support Node ≥ 20).

## Acknowledgements

Researchers who follow this policy are credited in the release notes and, with their consent, listed at [SECURITY-HALL-OF-FAME.md](./SECURITY-HALL-OF-FAME.md) once we have entries.
