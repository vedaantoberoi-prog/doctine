/*
 * Doctine website · 3D hero scene, as a self-contained bundle for doctine.com.
 * Built with `npm run build:embed` into dist-embed/hero3d.js and copied to website/assets/hero3d/.
 *
 * The page stays complete without it: the scene only adds a picture behind the hero text.
 * It mounts into [data-hero3d], reads scroll progress from the hero section it sits in,
 * stops drawing while the hero is off screen, and draws a still frame when the visitor
 * prefers reduced motion. It makes no network requests.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HeroScene from './components/hero/HeroScene';
import { prefersReducedMotion, supportsWebGL } from './lib/device';

function EmbeddedScene({ host, section }: { host: HTMLElement; section: HTMLElement }) {
  const progress = useRef(0);
  const [visible, setVisible] = useState(true);
  const [reduced] = useState(prefersReducedMotion);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = section.getBoundingClientRect();
      const raw = rect.height > 0 ? -rect.top / rect.height : 0;
      progress.current = Math.min(1, Math.max(0, raw));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    io.observe(section);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      io.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [section]);

  return (
    <HeroScene
      progress={progress}
      reduced={reduced}
      frameloop={!visible ? 'never' : reduced ? 'demand' : 'always'}
      shift={0.24}
      onReady={() => host.classList.add('is-ready')}
    />
  );
}

function mount() {
  const host = document.querySelector<HTMLElement>('[data-hero3d]');
  const section = host?.closest<HTMLElement>('section');
  if (!host || !section || !supportsWebGL()) return;
  createRoot(host).render(
    <StrictMode>
      <EmbeddedScene host={host} section={section} />
    </StrictMode>,
  );
}

mount();
