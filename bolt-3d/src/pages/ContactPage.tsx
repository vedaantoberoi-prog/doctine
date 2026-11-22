import { useState, type ChangeEvent, type FormEvent } from 'react';
import { LegalPage } from '@/components/LegalPage';
import {
  submitContactMessage,
  validateContactForm,
  type ContactFormErrors,
  type ContactFormValues,
} from '@/lib/contact';

const EMPTY_VALUES: ContactFormValues = { name: '', email: '', message: '' };

const FIELD_CLASS =
  'mt-2 w-full rounded-xl border bg-white px-4 py-3 text-base text-midnight placeholder:text-midnight/40 transition-colors focus:border-cobalt focus:outline-none focus:ring-2 focus:ring-cobalt/30';

export function ContactPage() {
  const [values, setValues] = useState<ContactFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<ContactFormErrors>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateContactForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setStatus('submitting');
    try {
      await submitContactMessage(values);
      setValues(EMPTY_VALUES);
      setStatus('sent');
    } catch {
      setStatus('error');
    }
  };

  const borderFor = (field: keyof ContactFormValues) => (errors[field] ? 'border-red-600' : 'border-silver');

  return (
    <LegalPage
      eyebrow="Contact"
      title="Get in touch with Doctine."
      intro="Questions, feedback or partnership enquiries. Tell us what you need."
    >
      {status === 'sent' ? (
        <div role="status" className="rounded-2xl border border-sage/40 bg-white p-8">
          <h2 className="font-serif text-2xl font-medium">Thank you. Your message has been sent.</h2>
          <p className="mt-3 text-midnight/75">We have received your message. Thank you for getting in touch.</p>
          <button
            type="button"
            onClick={() => setStatus('idle')}
            className="mt-6 rounded-full border border-midnight/30 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-midnight hover:text-ivory"
          >
            Send another message
          </button>
        </div>
      ) : (
        <form noValidate onSubmit={handleSubmit} className="space-y-6 rounded-2xl border border-silver bg-white p-6 md:p-10">
          <div>
            <label htmlFor="contact-name" className="block text-sm font-medium">
              Name
            </label>
            <input
              id="contact-name"
              name="name"
              type="text"
              autoComplete="name"
              value={values.name}
              onChange={handleChange}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'contact-name-error' : undefined}
              className={`${FIELD_CLASS} ${borderFor('name')}`}
            />
            {errors.name && (
              <p id="contact-name-error" className="mt-2 text-sm text-red-700">
                {errors.name}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="contact-email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="contact-email"
              name="email"
              type="email"
              autoComplete="email"
              value={values.email}
              onChange={handleChange}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'contact-email-error' : undefined}
              className={`${FIELD_CLASS} ${borderFor('email')}`}
            />
            {errors.email && (
              <p id="contact-email-error" className="mt-2 text-sm text-red-700">
                {errors.email}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="contact-message" className="block text-sm font-medium">
              Message
            </label>
            <textarea
              id="contact-message"
              name="message"
              rows={6}
              value={values.message}
              onChange={handleChange}
              aria-invalid={Boolean(errors.message)}
              aria-describedby={errors.message ? 'contact-message-error' : undefined}
              className={`${FIELD_CLASS} ${borderFor('message')} resize-y`}
            />
            {errors.message && (
              <p id="contact-message-error" className="mt-2 text-sm text-red-700">
                {errors.message}
              </p>
            )}
          </div>

          {status === 'error' && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
              We could not send your message. Please check your connection and try again.
            </p>
          )}

          <p className="text-sm text-midnight/70">
            Please do not include medical records or emergency details here. In a medical emergency, call 112.
          </p>

          <button
            type="submit"
            disabled={status === 'submitting'}
            className="rounded-full bg-midnight px-6 py-3 text-sm font-medium text-ivory transition-colors hover:bg-cobalt-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === 'submitting' ? 'Sending...' : 'Send message'}
          </button>
        </form>
      )}
    </LegalPage>
  );
}
