import { Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { APP_URL } from '@/lib/links';

export function SiteHeader({ variant }: { variant: 'overlay' | 'solid' }) {
  const surface =
    variant === 'overlay'
      ? 'bg-gradient-to-b from-midnight/50 to-transparent'
      : 'border-b border-white/10 bg-midnight/95 backdrop-blur';

  return (
    <header className={`fixed inset-x-0 top-0 z-30 ${surface}`}>
      <nav aria-label="Primary" className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 md:px-12">
        <Link to="/" className="flex items-center gap-2.5 rounded-sm text-white">
          <Layers className="h-6 w-6" aria-hidden="true" />
          <span className="font-serif text-2xl font-medium tracking-wide">Doctine</span>
        </Link>
        <div className="flex items-center gap-3 text-sm font-medium text-white sm:gap-6">
          <Link to="/contact" className="rounded-sm px-2 py-1.5 transition-opacity hover:opacity-80">
            Contact
          </Link>
          <a href={APP_URL} className="rounded-sm px-2 py-1.5 transition-opacity hover:opacity-80">
            Sign in
          </a>
          <a
            href={APP_URL}
            className="hidden rounded-full border border-white/70 px-4 py-2 transition-colors hover:bg-white hover:text-cobalt-deep sm:inline-block sm:px-5"
          >
            Create account
          </a>
        </div>
      </nav>
    </header>
  );
}
