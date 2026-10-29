# Using remotion-gpu with Claude Code

This repository ships a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) in
`.claude/skills/remotion-gpu/SKILL.md`. Once installed in a Remotion project, Claude loads it whenever it is about to
render or export a video on a Linux machine with an NVIDIA GPU: it runs the doctor first, picks P1 or the layered
render, uses the exact flags, avoids the known pitfalls, measures with `measure.mjs` and always renders contained.

## Install the skill in a project

Clone the toolkit somewhere stable and install its dependencies:

```bash
git clone https://github.com/konecz/remotion-gpu.git ~/tools/remotion-gpu
cd ~/tools/remotion-gpu && npm install
```

Then, in your Remotion project, either copy the skill folder:

```bash
mkdir -p .claude/skills
cp -r ~/tools/remotion-gpu/.claude/skills/remotion-gpu .claude/skills/
```

or link it, so it follows `git pull` in the toolkit:

```bash
mkdir -p .claude/skills
ln -s ~/tools/remotion-gpu/.claude/skills/remotion-gpu .claude/skills/remotion-gpu
```

A copy can be committed with the project; a symlink only works on machines where the toolkit lives at the same path.
To have the skill in every project on your machine, put it (copy or link) in `~/.claude/skills/` instead.

Start a new Claude Code session in the project (skills are loaded at start-up), ask it to render the video and check
that it runs the doctor first.

## Snippet for the project's CLAUDE.md

Paste this into the `CLAUDE.md` of the video project and adjust the path, the composition and the chosen path:

```markdown
## Rendering

- Render with the `remotion-gpu` skill (toolkit at `~/tools/remotion-gpu`, referred to as `$RGPU`). Run
  `node $RGPU/bin/doctor.mjs --cwd .` before the first render on a machine.
- Remotion is pinned to 4.0.536 (the toolkit and its dedup patch are verified on that version only). Do not upgrade it
  without checking the doctor and `RGPU_DEDUP=verify`.
- This project uses path: P1 (`<Video>` from `@remotion/media` + NVENC) | P2/P3 (layers, script `render-layers.mjs`
  in this project). <!-- keep one -->
- With NVENC, never pass `--crf`; quality goes by `--video-bitrate` (P1) or `--cq` (layers).
- Every render runs contained (nice 19, idle I/O, CPU ceiling): through `ensureContained()` or the
  `systemd-run --user --scope -p CPUQuota=800% nice -n 19 ionice -c 3` prefix. Never a bare `npx remotion render`.
- Compare changes with `node $RGPU/src/measure.mjs --runs 2 --label <name> -- <command>`, not with a single run.
```
