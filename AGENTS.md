# Application repository instructions

This repository contains LocalBridge source, tests, build/CI configuration, safe examples, and documentation needed to use or contribute to the application.

- Use Node.js 24 and `npm ci` with the committed lockfile. Run `npm run check` for typechecking, build, and tests; use targeted tests while iterating.
- Keep upstream files under `vendor/upstream/` unchanged unless intentionally updating the pinned baseline and manifest. Preserve licenses and attribution.
- Keep public documentation self-contained. Internal architecture, implementation plans, investigations, and execution evidence belong in the paired private engineering repository; they must not become build or test dependencies.
- Never commit local `.env`, `config.json`, databases, keys, logs, or secrets. Use generic values in examples.
- Preserve filesystem and authentication boundaries. Use temporary roots and isolated loopback listeners for tests, not a running deployment's data or credentials.
- Report only checks actually executed, including explicit skips and unresolved failures. Review the full staged tree before an initial publication.
