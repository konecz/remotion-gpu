# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. We answer within 7 days.

## Scope

`remotion-gpu` runs local commands (`ffmpeg`, `systemd-run`, Remotion's Chrome) on the machine where you render.
Reports we care about most:

- command or argument injection through a plan file, a composition id or a CLI option;
- a benchmark `submission.json` leaking paths, user names, host names or other personal data;
- the dedup patch reusing a frame that should have been captured again.

Plans and compositions are code you run on your own machine: treat a plan from someone else like a script from someone else.

## Known advisories

- **zod < 4.6.6 (high: memory exhaustion when validating oversized constrained collections).**
  Remotion 4.0.536 requires exactly `zod@4.5.4`. Forcing 4.6.6 still renders, but Remotion reports it
  as an unsupported combination, so we keep 4.5.4. Here zod only validates composition props that you
  write on your own machine; it never parses input from the network. Do not pass untrusted, very large
  props to a composition. We will move to the first Remotion release that ships zod 4.6.6 or later.

## Supported versions

Only the latest commit on `main` is supported.
