import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { APP_URL } from '@/lib/links';
import { prefersReducedMotion, supportsWebGL } from '@/lib/device';

const HeroScene = lazy(() => import('./hero/HeroScene'));

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null);
  const progressRef = useRef(0);
  const [webgl] = useState(supportsWebGL);
  const [reduced] = useState(prefersReducedMotion);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const scrollable = section.offsetHeight - window.innerHeight;
      const raw = scrollable > 0 ? -section.getBoundingClientRect().top / scrollable : 0;
      progressRef.current = Math.min(1, Math.max(0, raw));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="hero-heading"
      className="relative h-[170vh]"
    >
      <div className="sticky top-0 h-screen overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_72%_38%,#4A8BEA_0%,#246BDB_42%,#123B78_100%)]"
        />

        {webgl && (
          <div
            aria-hidden="true"
            className={`absolute inset-0 transition-opacity duration-[1200ms] ease-out ${ready ? 'opacity-100' : 'opacity-0'}`}
          >
            <Suspense fallback={null}>
              <HeroScene progress={progressRef} reduced={reduced} onReady={() => setReady(true)} />
            </Suspense>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-midnight/85 via-midnight/25 to-transparent md:bg-gradient-to-r md:from-midnight/80 md:via-midnight/35 md:to-transparent" />

        <div className="relative z-10 flex h-full flex-col justify-end px-6 pb-14 pt-28 md:justify-center md:px-12 md:pb-20 lg:px-20">
          <div className="max-w-2xl">
            <p className="mb-5 text-xs font-medium uppercase tracking-[0.28em] text-silver">
              Your personal health record
            </p>
            <h1
              id="hero-heading"
              className="font-serif text-5xl font-medium leading-[1.2] text-white sm:text-6xl lg:text-7xl"
            >
              Your health has a history.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-[1.5] text-white/90 md:text-lg">
              Prescriptions, reports, medicines and the details that matter. They deserve a place where everything
              comes together.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <a
                href={APP_URL}
                className="group inline-flex items-center gap-2 rounded-full bg-ivory px-6 py-3.5 text-sm font-medium text-midnight shadow-lg shadow-midnight/20 transition-all hover:-translate-y-0.5 hover:bg-white"
              >
                Create your free account
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
              </a>
              <a
                href="#platform"
                className="rounded-full border border-white/60 px-6 py-3.5 text-sm font-medium text-white transition-colors hover:border-white hover:bg-white/10"
              >
                Explore the platform
              </a>
            </div>
          </div>

          <p className="mt-12 text-xs leading-[1.5] text-silver/90 md:absolute md:bottom-8 md:left-12 md:mt-0 lg:left-20">
            Health profiles · Medical reports · Prescriptions · Medicine schedules
          </p>
        </div>
      </div>
    </section>
  );
}
