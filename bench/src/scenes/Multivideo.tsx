// C. Several videos at once: in each 9 s segment, a 2x2 grid of four takes in the first half and one take fullscreen
// with another as picture-in-picture in the second. At least two takes decode in every frame. The layered render
// puts one take per segment, so this kind does not go through it (recorded as not applicable).
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { color, type Props } from "../common";
import { frameC, segments, take } from "../geometry";
import { Captions, Take } from "./parts";

const Segment: React.FC<{ i: number; mode: Props["video"] }> = ({ i, mode }) => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = width / 1920;
  return (
    <AbsoluteFill>
      {frameC(i, f, width, height).map((c, k, all) => (
        // Keyed by take: the same element keeps playing when it moves from the grid to fullscreen or the PiP.
        <Take key={c.take} src={take(c.take)} box={c.box} video={c.video} mode={mode} e={all.length === 2 && k === 1 ? 1 : 0} background={color.dark} />
      ))}
      <div style={{ position: "absolute", left: 40 * u, top: 40 * u, width: 18 * u, height: 18 * u, borderRadius: "50%", background: "#e11d48" }} />
    </AbsoluteFill>
  );
};

export const Multivideo: React.FC<Props> = ({ video }) => {
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: video === "none" ? undefined : color.dark }}>
      {segments(durationInFrames).map((s) => (
        <Sequence key={s.i} from={s.start} durationInFrames={s.frames} layout="none">
          <Segment i={s.i} mode={video} />
        </Sequence>
      ))}
      <Captions />
    </AbsoluteFill>
  );
};
