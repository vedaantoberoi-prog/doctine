import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function LegalPage({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <article className="bg-ivory text-midnight">
      <div className="mx-auto max-w-3xl px-6 pb-24 pt-36 md:px-12 md:pt-44">
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-sage">{eyebrow}</p>
        <h1 className="mt-4 font-serif text-4xl font-medium leading-[1.2] md:text-5xl">{title}</h1>
        {intro && <p className="mt-6 text-lg leading-[1.5] text-midnight/75">{intro}</p>}
        <div className="mt-12 space-y-12">{children}</div>
        <p className="mt-16 border-t border-silver pt-8 text-sm">
          <Link to="/" className="font-medium text-cobalt-deep underline-offset-4 hover:underline">
            Back to the homepage
          </Link>
        </p>
      </div>
    </article>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-serif text-2xl font-medium leading-[1.2]">{heading}</h2>
      <div className="mt-4 space-y-4 text-base leading-[1.5] text-midnight/80">{children}</div>
    </section>
  );
}
