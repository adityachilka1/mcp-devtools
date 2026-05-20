# Getting help

A short triage guide so you find the right channel fast.

| You want to… | Use this |
|---|---|
| Report a bug you can reproduce | [Open an issue](https://github.com/adityachilka1/mcp-devtools/issues/new?template=bug_report.yml) — attach the `.mcptrace` if you have one. |
| Ask "is this a bug, or am I holding it wrong?" | [Discussions → Q&A](https://github.com/adityachilka1/mcp-devtools/discussions/categories/q-a). |
| Propose a new capability | [Open a feature request](https://github.com/adityachilka1/mcp-devtools/issues/new?template=feature_request.yml). |
| Share something cool you built on top | [Discussions → Show and tell](https://github.com/adityachilka1/mcp-devtools/discussions/categories/show-and-tell). |
| Report a security issue | **Do not open a public issue.** See [SECURITY.md](./SECURITY.md). |
| Chat with maintainers and other users | Discord — link in the README header. |

## Before opening an issue

A reproducer that the maintainer can run in under 60 seconds is the single highest-leverage thing you can include. The shortest path to that:

```bash
mcp-devtools record --upstream "<your command>" --out repro.mcptrace
# then trigger the bug, Ctrl-C, attach repro.mcptrace
```

That gives us the exact wire-level transcript and is usually enough to diagnose the issue without a back-and-forth.

## Response time

This is an open-source side project. Best-effort response within 24 hours for triage, within 7 days for non-critical fixes. Security issues get expedited treatment per the [security policy](./SECURITY.md).
