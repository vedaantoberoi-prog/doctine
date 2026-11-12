import { Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { APP_URL } from '@/lib/links';

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-midnight text-silver">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-12 md:flex-row md:items-center md:justify-between md:px-12 lg:px-20">
        <div className="flex flex-col gap-3">
          <Link to="/" className="flex items-center gap-2.5 text-ivory">
            <Layers className="h-5 w-5" aria-hidden="true" />
            <span className="font-serif text-xl font-medium tracking-wide">Doctine</span>
          </Link>
          <p className="text-sm leading-[1.5] text-silver/80">Personal health information, brought together. Built in India.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Link to="/about" className="transition-colors hover:text-white">
            About
          </Link>
          <Link to="/terms" className="transition-colors hover:text-white">
            Terms of service
          </Link>
          <Link to="/contact" className="transition-colors hover:text-white">
            Contact
          </Link>
          <a href={APP_URL} className="transition-colors hover:text-white">
            Sign in
          </a>
        </nav>
      </div>
    </footer>
  );
}
