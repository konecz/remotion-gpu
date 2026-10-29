// Pieces reused by the compositions: word-by-word captions, a lower third, a take of video in each mode
// (<OffthreadVideo>, <Video> from @remotion/media, or nothing) and the card frame.
import { Video } from "@remotion/media";
import { OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { PHRASE, WORDS, WORD_SECONDS, color, font, type VideoMode } from "../common";
import type { Box, Rect } from "../geometry";

/** Phrase of up to 5 words, the current word highlighted with a pop. */
export const Captions: React.FC<{ top?: number }> = ({ top }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = width / 1920;
  const current = Math.floor(f / fps / WORD_SECONDS);
  const first = Math.floor(current / PHRASE) * PHRASE;
  const phrase = Array.from({ length: PHRASE }, (_, k) => WORDS[(first + k) % WORDS.length]);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: top ?? height * 0.82, display: "flex", justifyContent: "center", fontFamily: font, fontWeight: 800, fontSize: 64 * u }}>
      <div style={{ display: "flex", gap: 26 * u, background: "rgba(15,27,45,0.82)", padding: `${14 * u}px ${28 * u}px`, borderRadius: 18 * u }}>
        {phrase.map((p, k) => {
          const who = first + k;
          const since = f - who * WORD_SECONDS * fps;
          const pop = who === current ? 1 + 0.06 * spring({ frame: since, fps, config: { damping: 12 }, durationInFrames: 8 }) : 1;
          return (
            <span key={k} style={{ color: who === current ? color.gold : color.light, opacity: who <= current ? 1 : 0.35, transform: `scale(${pop})`, display: "inline-block" }}>
              {p}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Name and role: slides in from the left at `from` seconds and out at `to`. */
export const LowerThird: React.FC<{ from: number; to: number; title: string; subtitle: string }> = ({ from, to, title, subtitle }) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = width / 1920;
  const enter = spring({ frame: f - from * fps, fps, config: { damping: 200 } });
  const exit = spring({ frame: f - to * fps, fps, config: { damping: 200 } });
  const x = interpolate(enter - exit, [0, 1], [-700 * u, 0]);
  if (enter - exit < 0.001) return null;
  return (
    <div style={{ position: "absolute", left: 80 * u + x, top: height * 0.62, fontFamily: font }}>
      <div style={{ background: color.dark, color: color.light, fontSize: 46 * u, fontWeight: 800, padding: `${12 * u}px ${28 * u}px` }}>{title}</div>
      <div style={{ background: color.gold, color: color.dark, fontSize: 30 * u, fontWeight: 600, padding: `${8 * u}px ${28 * u}px`, display: "inline-block" }}>{subtitle}</div>
    </div>
  );
};

/** A take in a box, cropped (overflow hidden) and placed; in "none", only the card frame (ffmpeg puts the take). */
export const Take: React.FC<{ src: string; box: Box; video: Rect; mode: VideoMode; e?: number; background?: string }> = ({
  src,
  box,
  video,
  mode,
  e = 0,
  background = color.background,
}) => {
  const { width } = useVideoConfig();
  const u = width / 1920;
  const shadow = e > 0 ? `0 ${24 * e * u}px ${60 * e * u}px rgba(7,16,31,${0.28 * e})` : undefined;
  const outline = e > 0 ? `${4 * e * u}px solid ${color.gold}` : undefined;
  const place = { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h } as const;
  if (mode === "none") {
    // Background over the rounded corners by a solid spread shadow (the take underneath is a square rectangle).
    const corners = box.radius > 0 ? `0 0 0 ${Math.ceil(box.radius)}px ${background}` : undefined;
    return <div style={{ ...place, borderRadius: box.radius, boxShadow: [shadow, corners].filter(Boolean).join(", ") || undefined, outline }} />;
  }
  const style = { position: "absolute", left: video.x, top: video.y, width: video.w, height: video.h } as const;
  return (
    <div style={{ ...place, overflow: "hidden", borderRadius: box.radius, boxShadow: shadow, outline }}>
      {mode === "media" ? <Video muted disallowFallbackToOffthreadVideo src={staticFile(src)} style={style} /> : <OffthreadVideo muted src={staticFile(src)} style={style} />}
    </div>
  );
};
