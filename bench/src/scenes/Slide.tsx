// E. A nearly still scene: a slide with a title, bullet points fading in one by one (0.4 s fade every 1.5 s) and a
// progress bar that moves once per second. Most frames are identical to the previous one: the case where skipping
// repeated frames (P3) should gain the most.
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { color, font, type Props } from "../common";

const BULLETS = ["Question", "Hypotheses", "Method", "Results", "Discussion", "Limitations"];

export const Slide: React.FC<Props> = ({ video }) => {
  const f = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const u = width / 1920;
  const second = Math.floor(f / fps);
  const total = Math.ceil(durationInFrames / fps);
  return (
    <AbsoluteFill style={{ background: video === "none" ? undefined : color.background, fontFamily: font, color: color.text }}>
      <div style={{ position: "absolute", left: 140 * u, top: 110 * u, fontSize: 96 * u, fontWeight: 900 }}>Render benchmark</div>
      <div style={{ position: "absolute", left: 140 * u, top: 240 * u, width: 160 * u, height: 10 * u, background: color.gold }} />
      {BULLETS.map((t, k) => {
        const start = (0.5 + k * 1.5) * fps;
        const op = interpolate(f, [start, start + 0.4 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={t} style={{ position: "absolute", left: 160 * u, top: (330 + k * 100) * u, fontSize: 56 * u, fontWeight: 600, opacity: op }}>
            {k + 1}. {t}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 14 * u, width: (width * Math.min(second + 1, total)) / total, background: color.blue }} />
      <div style={{ position: "absolute", right: 80 * u, bottom: 50 * u, fontSize: 34 * u, color: "#667085" }}>{`${second + 1} / ${total}`}</div>
    </AbsoluteFill>
  );
};
