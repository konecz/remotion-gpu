// Shared pieces: props, a seeded generator (frames come out the same in any render), colors, font and caption text.
// Nothing here depends on the clock or on Math.random.

/** How video enters the composition: "offthread" (<OffthreadVideo>, the factory default), "media" (<Video> from
 * @remotion/media, WebCodecs) or "none" (graphics only over a transparent background, for the layered render). */
export type VideoMode = "offthread" | "media" | "none";

export type Props = { width: number; height: number; seconds: number; video: VideoMode };

export const FPS = 30;
export const DEFAULTS: Props = { width: 1920, height: 1080, seconds: 4, video: "offthread" };

/** mulberry32: deterministic, fast and good enough for positions and colors. */
export const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const color = {
  background: "#f4f2ee",
  dark: "#0f1b2d",
  gold: "#c9a227",
  blue: "#1d4ed8",
  text: "#0f1b2d",
  light: "#ffffff",
};

// A locally installed font, or the generic fallback: no font download at render time (network adds variance).
export const font = "Inter, 'DejaVu Sans', Arial, sans-serif";

const TEXT =
  "rendering video from code spends most of its time building each frame in the browser, capturing the image and " +
  "decoding the embedded videos; the graphics card can decode, composite and encode, but only if the path lets it; " +
  "this test measures how much processor time and wall time each path spends, and how much quality it loses, on " +
  "different kinds of video: graphics only, a presenter with captions, several videos at once, heavy effects and a " +
  "nearly still slide; every number comes from several runs in random order, on a quiet machine";

export const WORDS = TEXT.split(/\s+/);
/** One word every WORD_SECONDS, in phrases of up to PHRASE words. */
export const WORD_SECONDS = 0.32;
export const PHRASE = 5;
