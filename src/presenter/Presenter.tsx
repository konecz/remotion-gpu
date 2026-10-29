// A presenter video inside a box: fullscreen, or a card next to other content, with a spring between the two, a slow
// zoom and punch-ins (framing.ts). Two modes:
//   - normal (path P1): draws the take with <Video> from @remotion/media, cropped by the box;
//   - graphicsOnly (path P2): draws only the card's frame (shadow, outline) and paints the background over the
//     rounded corners with a solid shadow, so ffmpeg can put the take UNDER the graphics as a plain rectangle.
import { Video } from "@remotion/media";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { framePresenter, type FramingProps } from "./framing";

export type PresenterProps = FramingProps & {
  /** File in public/ (passed to staticFile) or a URL. */
  src: string;
  /** Frames to skip at the start of the file. */
  trimBefore?: number;
  muted?: boolean;
  volume?: number;
  /** Color around the card (also painted over the card's rounded corners in graphicsOnly mode). */
  background?: string;
  /** Card outline color (drawn while in the card). */
  outlineColor?: string;
  /** Card outline width in px at full card (default 4). */
  outlineWidth?: number;
  /** Draw only the frame decorations, not the video (layered render). */
  graphicsOnly?: boolean;
};

export const Presenter: React.FC<PresenterProps> = ({
  src,
  trimBefore,
  muted,
  volume,
  background = "#000000",
  outlineColor,
  outlineWidth = 4,
  graphicsOnly = false,
  ...framing
}) => {
  const f = useCurrentFrame();
  const config = useVideoConfig();
  const { box, e, video } = framePresenter(framing, f, config);
  const shadow = e > 0 ? `0 ${24 * e}px ${60 * e}px rgba(7,16,31,${0.28 * e})` : undefined;
  const outline = e > 0 && outlineColor ? `${outlineWidth * e}px solid ${outlineColor}` : undefined;
  const place = { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h } as const;

  if (graphicsOnly) {
    // ffmpeg draws the background and the take inside the box (square corners); here go the frame and, over the
    // rounded corners, the background, by a solid spread shadow that covers them.
    const corners = box.radius > 0 ? `0 0 0 ${Math.ceil(box.radius)}px ${background}` : undefined;
    return <div style={{ ...place, borderRadius: box.radius, boxShadow: [shadow, corners].filter(Boolean).join(", ") || undefined, outline }} />;
  }

  const url = /^(https?:|data:|blob:)/.test(src) ? src : staticFile(src);
  return (
    <AbsoluteFill style={{ background }}>
      <div style={{ ...place, overflow: "hidden", borderRadius: box.radius, boxShadow: shadow, outline }}>
        {/* <Video> decodes in Chrome (WebCodecs) instead of Remotion's compositor. No silent fallback to
            <OffthreadVideo>: if WebCodecs cannot handle the file, the render fails and you see it. */}
        <Video
          src={url}
          trimBefore={trimBefore}
          muted={muted}
          volume={volume}
          disallowFallbackToOffthreadVideo
          style={{ position: "absolute", left: video.x, top: video.y, width: video.w, height: video.h }}
        />
      </div>
    </AbsoluteFill>
  );
};
