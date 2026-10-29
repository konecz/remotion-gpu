// A. Motion graphics only: kinetic typography (one big word at a time, with spring, tilt and color), moving shapes,
// a counter and word-by-word captions. No video. Every frame changes.
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { WORDS, color, font, seeded, type Props } from "../common";
import { Captions } from "./parts";

const SHAPES = (() => {
  const r = seeded(7);
  return Array.from({ length: 14 }, () => ({ x: r(), y: r(), v: 0.3 + r(), spin: r() * 4 - 2, size: 60 + r() * 160, circle: r() > 0.5, h: Math.floor(r() * 360) }));
})();

const WORD_DURATION = 0.8; // seconds per big word

export const Typography: React.FC<Props> = ({ video }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = width / 1920;
  const i = Math.floor(f / fps / WORD_DURATION);
  const since = f - i * WORD_DURATION * fps;
  const r = seeded(1000 + i);
  const enter = spring({ frame: since, fps, config: { damping: 11 } });
  const word = WORDS[(i * 3) % WORDS.length].replace(/[,;:]/g, "");
  return (
    <AbsoluteFill style={{ background: video === "none" ? undefined : color.dark, overflow: "hidden" }}>
      {SHAPES.map((s, k) => {
        const t = f / fps;
        const x = ((s.x * width + t * s.v * 140 * u) % (width + 300 * u)) - 150 * u;
        const y = s.y * height + Math.sin(t * s.v + k) * 60 * u;
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: s.size * u,
              height: s.size * u,
              borderRadius: s.circle ? "50%" : 12 * u,
              border: `${6 * u}px solid hsl(${s.h} 70% 60%)`,
              transform: `rotate(${t * s.spin * 60}deg)`,
              opacity: 0.55,
            }}
          />
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: height * 0.3,
          textAlign: "center",
          fontFamily: font,
          fontWeight: 900,
          fontSize: 190 * u,
          letterSpacing: -4 * u,
          color: `hsl(${Math.floor(r() * 360)} 85% 65%)`,
          transform: `scale(${interpolate(enter, [0, 1], [0.4, 1])}) rotate(${(r() - 0.5) * 16 * (1 - enter)}deg)`,
          opacity: enter,
        }}
      >
        {word}
      </div>
      <div style={{ position: "absolute", right: 60 * u, top: 50 * u, fontFamily: font, fontWeight: 700, fontSize: 56 * u, color: color.gold }}>
        {String(Math.floor((f * 37) % 100000)).padStart(5, "0")}
      </div>
      <Captions />
    </AbsoluteFill>
  );
};
