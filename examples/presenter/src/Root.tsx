import { Composition } from "remotion";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./timeline";
import { PresenterVideo, type VideoProps } from "./Video";

const defaults: VideoProps = { graphicsOnly: false };

export const Root: React.FC = () => (
  <Composition
    id="Presenter"
    component={PresenterVideo}
    defaultProps={defaults}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    durationInFrames={TOTAL_FRAMES}
  />
);
