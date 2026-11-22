// The state of the 3D world. The page's scroll position writes it (src/embed.tsx, with GSAP ScrollTrigger);
// the scene reads it every frame. Plain numbers, so nothing re-renders.
export type WorldState = {
  intro: number; // 0 → 1 once on load: objects arrive
  gather: number; // 0 scattered papers → 1 filed in the archive
  pull: number; // 0 close → 1 camera drawn back and raised
  dusk: number; // 0 daylight → 1 deep evening blue
  shift: number; // picture shifted sideways on wide screens (fraction of width; + moves it right)
};

export const world: WorldState = { intro: 1, gather: 0, pull: 0, dusk: 0, shift: 0 };
