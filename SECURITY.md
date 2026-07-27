# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/santiagoisra/nitidoc/security/advisories/new).
That opens a draft advisory only you and the maintainers can see.

Expect a first reply within a few days. This is a small, volunteer-maintained
project — there is no on-call rotation and no bug bounty, but every report is
read and taken seriously.

## What is in scope

Nitidoc is a fully client-side application. There is no backend, no user
accounts and no server-side storage of documents: everything — camera capture,
edge detection, perspective warp, filters and PDF export — runs in the browser
on the user's own device.

That shapes what a vulnerability looks like here. In scope:

- Anything that causes a scanned document, or an image derived from it, to
  leave the device.
- Cross-site scripting or code injection in the app or the landing page.
- Weaknesses in how pages are persisted locally (IndexedDB / storage) that let
  another origin or another app read them.
- Supply-chain issues in the dependencies we ship to the browser.
- A service-worker or cache flaw that serves one user's data to another
  (for example on a shared device).

Out of scope:

- Findings that require a compromised or physically unlocked device.
- Missing hardening headers with no demonstrated impact.
- Automated scanner output pasted without a working proof of concept.
- Vulnerabilities in Firebase Hosting itself — report those to Google.

## Supported versions

Nitidoc is a continuously deployed web app. The deployed version at
[nitidoc.com](https://nitidoc.com) and the current `main` branch are the only
supported targets; fixes ship forward rather than as patches to older tags.
