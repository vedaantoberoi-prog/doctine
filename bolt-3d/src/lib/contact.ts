import { supabase } from '@/lib/supabase';

export type ContactFormValues = {
  name: string;
  email: string;
  message: string;
};

export type ContactFormErrors = Partial<Record<keyof ContactFormValues, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContactForm(values: ContactFormValues): ContactFormErrors {
  const errors: ContactFormErrors = {};
  const name = values.name.trim();
  const email = values.email.trim();
  const message = values.message.trim();

  if (!name) errors.name = 'Please tell us your name.';
  else if (name.length > 120) errors.name = 'Please keep your name under 120 characters.';

  if (!email) errors.email = 'Please enter your email address.';
  else if (email.length > 254 || !EMAIL_PATTERN.test(email)) errors.email = 'Please enter a valid email address.';

  if (!message) errors.message = 'Please write a message.';
  else if (message.length > 2000) errors.message = 'Please keep your message under 2000 characters.';

  return errors;
}

export async function submitContactMessage(values: ContactFormValues): Promise<void> {
  const { error } = await supabase.from('contact_messages').insert({
    name: values.name.trim(),
    email: values.email.trim(),
    message: values.message.trim(),
  });
  if (error) throw error;
}
