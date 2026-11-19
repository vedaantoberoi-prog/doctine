import { CalendarDays, History, Pill, User } from 'lucide-react';
import { APP_URL } from '@/lib/links';

const PLATFORM_FEATURES = [
  {
    id: 'profiles',
    icon: User,
    title: 'Personal health profiles',
    description: 'Keep your own health profile with the details that matter, in one private place.',
    points: [
      'Medical reports and prescriptions kept together',
      'Searchable medical history',
      'Text-based PDF reports read into your record',
    ],
  },
  {
    id: 'medicines',
    icon: Pill,
    title: 'Medicine schedules',
    description: 'Set out what you take and when, and keep a clear record of every dose.',
    points: ['Medicine schedules you can review at any time', 'Dose history over time', 'Your records stay under your control'],
  },
] as const;

export function PlatformOverview() {
  return (
    <section id="platform" aria-labelledby="platform-heading" className="bg-ivory text-midnight">
      <div className="mx-auto max-w-7xl px-6 py-24 md:px-12 md:py-32 lg:px-20">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-sage">The platform</p>
          <h2 id="platform-heading" className="mt-4 font-serif text-4xl font-medium leading-[1.2] md:text-5xl">
            Everything you need for your personal record, in one place.
          </h2>
          <p className="mt-6 text-base leading-[1.5] text-midnight/75 md:text-lg">
            Doctine organises the information you add to your health record, so it stays searchable and available
            when you need it.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2">
          {PLATFORM_FEATURES.map(({ id, icon: Icon, title, description, points }) => (
            <article
              key={id}
              aria-labelledby={`${id}-title`}
              className="group flex flex-col rounded-3xl border border-silver/80 bg-white p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-midnight/10 md:p-10"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sage/15 text-sage">
                <Icon className="h-6 w-6" aria-hidden="true" />
              </div>
              <h3 id={`${id}-title`} className="mt-8 font-serif text-3xl font-medium leading-[1.2]">
                {title}
              </h3>
              <p className="mt-4 text-base leading-[1.5] text-midnight/75">{description}</p>
              <ul className="mt-8 space-y-3 border-t border-silver/80 pt-8 text-sm leading-[1.5] text-midnight/80">
                {points.map((point) => (
                  <li key={point} className="flex items-start gap-3">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-champagne" aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-6 rounded-3xl bg-midnight px-8 py-8 text-ivory md:flex-row md:items-center md:px-12">
          <div className="flex items-center gap-4">
            <CalendarDays className="h-6 w-6 shrink-0 text-champagne" aria-hidden="true" />
            <History className="h-6 w-6 shrink-0 text-silver" aria-hidden="true" />
            <p className="max-w-xl text-base leading-[1.5] text-ivory/90">
              Your record grows with you. Add what you have, and find it again whenever you need it.
            </p>
          </div>
          <a
            href={APP_URL}
            className="inline-flex shrink-0 items-center rounded-full bg-ivory px-6 py-3 text-sm font-medium text-midnight transition-colors hover:bg-white"
          >
            Start your health record
          </a>
        </div>
      </div>
    </section>
  );
}
