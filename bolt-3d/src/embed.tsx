/*
 * Doctine website · the 3D world, as one self-contained bundle for doctine.com.
 * Built with `npm run build:embed` into dist-embed/hero3d.js and copied to website/assets/hero3d/.
 *
 * The page is complete without it. The world mounts into the fixed [data-world] element behind the page and is seen
 * through the page's "window" sections (those with data-scene). GSAP ScrollTrigger ties each window's scroll range
 * to the state of the world (lib/world.ts): how gathered the papers are, how far the camera has drawn back, how late
 * the light is, and which side the picture sits on. Scrolling is never taken over.
 *
 * It stops drawing while no window is on screen, draws still frames for visitors who prefer reduced motion, and
 * makes no network requests.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import HeroScene from './components/hero/HeroScene';
import { prefersReducedMotion, supportsWebGL } from './lib/device';
import { world, type WorldState } from './lib/world';

gsap.registerPlugin(ScrollTrigger);

type Pose = Pick<WorldState, 'gather' | 'pull' | 'dusk' | 'shift'>;
// Where the world starts and ends while each window crosses the middle of the screen.
const CHAPTERS: Record<string, { from: Pose; to: Pose }> = {
  hero: { from: { gather: 0, pull: 0.22, dusk: 0.8, shift: 0.2 }, to: { gather: 0.18, pull: 0.1, dusk: 0.85, shift: 0.22 } },
  gather: { from: { gather: 0.18, pull: 0.1, dusk: 0.85, shift: 0.24 }, to: { gather: 1, pull: 0.15, dusk: 0.9, shift: 0.24 } },
  future: { from: { gather: 1, pull: 0.35, dusk: 0.95, shift: -0.22 }, to: { gather: 1, pull: 0.8, dusk: 1, shift: -0.22 } },
  close: { from: { gather: 1, pull: 0.8, dusk: 1, shift: 0 }, to: { gather: 1, pull: 1, dusk: 0.9, shift: 0 } },
};

function World({ host, windows }: { host: HTMLElement; windows: HTMLElement[] }) {
  const [visible, setVisible] = useState(true);
  const [reduced] = useState(prefersReducedMotion);

  useEffect(() => {
    const ctx = gsap.context(() => {
      Object.assign(world, CHAPTERS.hero.from);
      if (!reduced) {
        world.intro = 0;
        gsap.to(world, { intro: 1, duration: 2.2, ease: 'power2.out', delay: 0.15 });
      }
      windows.forEach((section) => {
        const chapter = CHAPTERS[section.dataset.scene ?? ''];
        if (!chapter) return;
        const first = section.dataset.scene === 'hero';
        gsap.fromTo(world, { ...chapter.from }, {
          ...chapter.to,
          ease: 'none',
          immediateRender: first,
          scrollTrigger: {
            trigger: section,
            start: first ? 'top top' : 'top center',
            end: 'bottom center',
            scrub: reduced ? true : 0.8,
          },
        });
      });
    });
    const seen = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? seen.add(e.target) : seen.delete(e.target)));
      setVisible(seen.size > 0);
    });
    windows.forEach((w) => io.observe(w));
    return () => {
      ctx.revert();
      io.disconnect();
    };
  }, [windows, reduced]);

  return (
    <HeroScene
      reduced={reduced}
      frameloop={visible ? 'always' : 'never'}
      onReady={() => host.classList.add('is-ready')}
    />
  );
}

function mount() {
  const host = document.querySelector<HTMLElement>('[data-world]');
  const windows = [...document.querySelectorAll<HTMLElement>('[data-scene]')];
  if (!host || !windows.length || !supportsWebGL()) return;
  createRoot(host).render(
    <StrictMode>
      <World host={host} windows={windows} />
    </StrictMode>,
  );
}

mount();
