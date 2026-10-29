// B. A presenter take fullscreen or in a card (spring between the two, slow zoom and punch-in), with word-by-word
// captions, a lower third and, while in the card, a title and bullet points beside it. One synthetic take per 9 s
// segment, in sequence.
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { color, font, type Props } from "../common";
import { frameB, segments, take } from "../geometry";
import { Captions, LowerThird, Take } from "./parts";

const BULLETS = ["Decode on the GPU", "Composite on the GPU", "Encode on the GPU"];

const Segment: React.FC<{ i: number; mode: Props["video"] }> = ({ i, mode }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = width / 1920;
  const q = frameB(i, f, width, height);
  return (
    <AbsoluteFill>
      <Take src={take(i)} box={q.box} video={q.video} mode={mode} e={q.e} />
      {q.e > 0.01 && (
        <div style={{ position: "absolute", left: 90 * u, top: height * 0.14, width: width * 0.4, fontFamily: font, color: color.text, opacity: q.e }}>
          <div style={{ fontSize: 76 * u, fontWeight: 900, lineHeight: 1.05 }}>GPU render, segment {i + 1}</div>
          {BULLETS.map((t, k) => {
            const op = interpolate(f, [(4.8 + k * 0.4) * fps, (5.2 + k * 0.4) * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div key={t} style={{ marginTop: 34 * u, fontSize: 44 * u, fontWeight: 600, opacity: i % 2 === 0 ? op : 1, display: "flex", gap: 18 * u, alignItems: "center" }}>
                <span style={{ width: 22 * u, height: 22 * u, borderRadius: "50%", background: color.gold, display: "inline-block" }} />
                {t}
              </div>
            );
          })}
        </div>
      )}
      <LowerThird from={1} to={4} title="Presenter" subtitle="Render test, synthetic take" />
    </AbsoluteFill>
  );
};

export const PresenterScene: React.FC<Props> = ({ video }) => {
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: video === "none" ? undefined : color.background }}>
      {segments(durationInFrames).map((s) => (
        <Sequence key={s.i} from={s.start} durationInFrames={s.frames} layout="none">
          <Segment i={s.i} mode={video} />
        </Sequence>
      ))}
      <Captions />
    </AbsoluteFill>
  );
};
