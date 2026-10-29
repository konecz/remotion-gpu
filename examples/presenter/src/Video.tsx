// The example composition: a synthetic presenter (fullscreen, card, slow zoom, punch-ins) with word-by-word
// captions, a lower third and a bar chart on top, then an outro card. With `graphicsOnly` it draws everything except
// the video and the background (transparent), for the layered render.
import { AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Presenter } from "../../../src/presenter";
import { ACCENT, BACKGROUND, BLOCKS, CAPTIONS_END, CHART, FOOTAGE, INK, PHRASE, WORDS, WORD_SECONDS } from "./timeline";

export type VideoProps = { graphicsOnly: boolean };

const FONT = "Inter, 'DejaVu Sans', Arial, sans-serif";

/** Phrase of up to PHRASE words, the current word highlighted with a small pop. */
const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  if (frame >= CAPTIONS_END) return null;
  const current = Math.floor(frame / fps / WORD_SECONDS);
  const first = Math.floor(current / PHRASE) * PHRASE;
  const words = Array.from({ length: PHRASE }, (_, k) => first + k).filter((i) => i < WORDS.length);
  if (!words.length) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: height * 0.84, display: "flex", justifyContent: "center", fontFamily: FONT, fontWeight: 800, fontSize: 58 }}>
      <div style={{ display: "flex", gap: 22, background: "rgba(15,27,45,0.82)", padding: "12px 26px", borderRadius: 16, whiteSpace: "nowrap" }}>
        {words.map((i) => {
          const since = frame - i * WORD_SECONDS * fps;
          const pop = i === current ? 1 + 0.06 * spring({ frame: since, fps, config: { damping: 12 }, durationInFrames: 8 }) : 1;
          return (
            <span key={i} style={{ color: i === current ? ACCENT : "#ffffff", opacity: i <= current ? 1 : 0.35, transform: `scale(${pop})`, display: "inline-block" }}>
              {WORDS[i]}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Name and role, sliding in from the left. */
const LowerThird: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = spring({ frame: frame - (durationInFrames - 12), fps, config: { damping: 200 } });
  const x = interpolate(enter - exit, [0, 1], [-760, 0]);
  return (
    <div style={{ position: "absolute", left: 80 + x, top: 640, fontFamily: FONT }}>
      <div style={{ background: INK, color: "#ffffff", fontSize: 46, fontWeight: 800, padding: "12px 28px" }}>{title}</div>
      <div style={{ background: ACCENT, color: INK, fontSize: 30, fontWeight: 600, padding: "8px 28px", display: "inline-block" }}>{subtitle}</div>
    </div>
  );
};

/** A simple bar chart, bars growing in one after the other. */
const Chart: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bars = [
    { label: "CPU only", value: 1.0 },
    { label: "P1", value: 0.34 },
    { label: "P2", value: 0.12 },
  ];
  const appear = spring({ frame: frame - 0.9 * fps, fps, config: { damping: 200 } });
  return (
    <div style={{ position: "absolute", left: CHART.x, top: CHART.y, width: CHART.w, height: CHART.h, fontFamily: FONT, color: INK, opacity: appear }}>
      <div style={{ fontSize: 56, fontWeight: 900, lineHeight: 1.1 }}>CPU seconds per video second</div>
      <div style={{ position: "absolute", top: 170, left: 0, right: 0 }}>
        {bars.map((b, i) => {
          const grow = spring({ frame: frame - (1.2 + 0.35 * i) * fps, fps, config: { damping: 200 } });
          return (
            <div key={b.label} style={{ display: "flex", alignItems: "center", marginBottom: 46 }}>
              <div style={{ width: 190, fontSize: 38, fontWeight: 700 }}>{b.label}</div>
              <div style={{ height: 70, width: 600 * b.value * grow, background: i === 0 ? "#94a3b8" : ACCENT, borderRadius: 10 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Opaque full-frame card: Chrome writes these PNG frames as RGB, which splits a layered segment. The entrance is a
 * clamped interpolation (a spring never settles exactly), so the frames after it are identical and the dedup patch
 * reuses them instead of capturing.
 */
const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ background: INK, justifyContent: "center", alignItems: "center", fontFamily: FONT }}>
      <div style={{ color: "#ffffff", fontSize: 110, fontWeight: 900, opacity: o, transform: `translateY(${(1 - o) * 40}px)` }}>remotion-gpu</div>
      <div style={{ color: ACCENT, fontSize: 40, fontWeight: 600, marginTop: 20, opacity: o }}>synthetic example</div>
    </AbsoluteFill>
  );
};

export const PresenterVideo: React.FC<VideoProps> = ({ graphicsOnly }) => (
  <AbsoluteFill style={{ background: graphicsOnly ? undefined : BACKGROUND }}>
    {BLOCKS.map((b) => (
      <Sequence key={b.start} from={b.start} durationInFrames={b.frames} layout="none">
        {b.presenter ? (
          <Presenter
            {...b.presenter}
            src={FOOTAGE}
            trimBefore={b.start}
            background={BACKGROUND}
            outlineColor={ACCENT}
            graphicsOnly={graphicsOnly}
          />
        ) : (
          <Outro />
        )}
      </Sequence>
    ))}
    <Sequence from={BLOCKS[1].start} durationInFrames={BLOCKS[1].frames} layout="none">
      <Chart />
    </Sequence>
    <Sequence from={15} durationInFrames={75} layout="none">
      <LowerThird title="Synthetic presenter" subtitle="Test pattern, composited on the GPU" />
    </Sequence>
    <Captions />
  </AbsoluteFill>
);
