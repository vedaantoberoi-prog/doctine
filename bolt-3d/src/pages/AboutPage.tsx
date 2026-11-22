import { LegalPage, LegalSection } from '@/components/LegalPage';
import { APP_URL } from '@/lib/links';

const PLATFORM_LAYERS = [
  {
    name: 'Doctine Personal',
    status: 'Available now',
    description:
      'Your private health record: profile, reports, prescriptions, medicines, dose history and timeline. Export or delete it at any time.',
  },
  {
    name: 'Doctine Intelligence',
    status: 'In development',
    description:
      'Plain-language explanations of medical terms and of your own reports, with follow-up questions and questions for your doctor. Switched on only after safety evaluation and review by doctors.',
  },
  {
    name: 'Doctine Knowledge',
    status: 'Planned',
    description:
      'Curated, source-linked medical information and consistent medical terminology, so explanations can show where they come from.',
  },
  {
    name: 'Doctine Ecosystem',
    status: 'Planned',
    description:
      'Receiving records from laboratories, clinics and hospitals, and sharing them with a doctor, always with your explicit consent.',
  },
];

const PRINCIPLES = [
  {
    title: 'Say only what is true',
    body: 'We describe features as available only when they work. Anything else is labelled as in development or planned.',
  },
  {
    title: 'The record belongs to the person',
    body: 'Your records are private to your account, and you can take them with you or delete them at any time.',
  },
  {
    title: 'Careful with AI',
    body: 'AI explanations are tested against safety cases and reviewed by doctors before release. They support medical care; they never replace it.',
  },
  {
    title: 'India first',
    body: 'Built for Indian prescriptions, lab reports and emergency services, with your data stored in India.',
  },
];

export function AboutPage() {
  return (
    <LegalPage
      eyebrow="About Doctine"
      title="Building a more connected foundation for personal health information."
      intro="We start with something simple and useful: a private record of your own health, in one place, that you control."
    >
      <LegalSection heading="Why Doctine exists">
        <p>
          Most people's health history is spread across paper prescriptions, lab portals, message threads and memory.
          Each piece is useful; together they are hard to use.
        </p>
        <p>
          When the details are scattered, it is harder to answer a doctor's questions, to notice what has changed, or to
          look after a parent's care from another city. Doctine's first job is to bring those pieces together,
          accurately, in a form you can find and share when you choose.
        </p>
        <p>
          <strong className="font-medium text-midnight">Our mission:</strong> make personal health information more
          accessible, organised and understandable, through careful technology.
        </p>
      </LegalSection>

      <LegalSection heading="The platform">
        <p>Each layer depends on the one before it being trustworthy. Only the first is available today.</p>
        <ul className="space-y-4">
          {PLATFORM_LAYERS.map((layer) => (
            <li key={layer.name} className="rounded-2xl border border-silver bg-white p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-serif text-xl font-medium">{layer.name}</h3>
                <span className="text-xs font-medium uppercase tracking-[0.2em] text-sage">{layer.status}</span>
              </div>
              <p className="mt-3">{layer.description}</p>
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection heading="How we build">
        <ul className="space-y-4">
          {PRINCIPLES.map((principle) => (
            <li key={principle.title}>
              <h3 className="font-medium text-midnight">{principle.title}</h3>
              <p className="mt-1">{principle.body}</p>
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection heading="The company">
        <p>
          Doctine is operated by Doctine Private Limited, India. We are an early-stage company and the product is in its
          first public release.
        </p>
        <p>
          Your account is at{' '}
          <a href={APP_URL} className="font-medium text-cobalt-deep underline-offset-4 hover:underline">
            app.doctine.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
