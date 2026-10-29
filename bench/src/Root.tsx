// The five synthetic compositions. Size, duration and video mode come from props
// (`--props='{"width":3840,"height":2160,"seconds":30,"video":"media"}'`), so one composition serves every path and size.
import { Composition, type CalculateMetadataFunction } from "remotion";
import { DEFAULTS, FPS, type Props } from "./common";
import { Effects } from "./scenes/Effects";
import { Multivideo } from "./scenes/Multivideo";
import { PresenterScene } from "./scenes/PresenterScene";
import { Slide } from "./scenes/Slide";
import { Typography } from "./scenes/Typography";

const metadata: CalculateMetadataFunction<Props> = ({ props }) => ({
  width: props.width,
  height: props.height,
  fps: FPS,
  durationInFrames: Math.round(props.seconds * FPS),
});

const KINDS = [
  ["A-Typography", Typography],
  ["B-Presenter", PresenterScene],
  ["C-Multivideo", Multivideo],
  ["D-Effects", Effects],
  ["E-Slide", Slide],
] as const;

export const Root: React.FC = () => (
  <>
    {KINDS.map(([id, C]) => (
      <Composition
        key={id}
        id={id}
        component={C}
        defaultProps={DEFAULTS}
        calculateMetadata={metadata}
        fps={FPS}
        width={DEFAULTS.width}
        height={DEFAULTS.height}
        durationInFrames={DEFAULTS.seconds * FPS}
      />
    ))}
  </>
);
