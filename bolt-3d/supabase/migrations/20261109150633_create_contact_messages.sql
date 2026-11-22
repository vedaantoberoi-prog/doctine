/*
# Create contact messages table

1. New Tables
- `contact_messages`: messages sent from the public contact form.
  - `id` (uuid, primary key)
  - `name` (text, required, 1 to 120 characters)
  - `email` (text, required, 3 to 254 characters)
  - `message` (text, required, 1 to 2000 characters)
  - `created_at` (timestamp, defaults to now)

2. Security
- Row level security is enabled, so the table is locked until policies are added.
- Visitors (anon and signed-in users) may only INSERT a message. They cannot read, edit or delete messages, including other people's.
- The insert policy is intentionally open to the public because anyone may send a contact message. It is limited to write-only access.
- No SELECT policy exists, so messages are readable only from the Supabase dashboard or privileged server code.

3. Notes
- Length checks are enforced in the database as a backstop to the form's validation.
*/

CREATE TABLE IF NOT EXISTS contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;

GRANT INSERT ON contact_messages TO anon, authenticated;

DROP POLICY IF EXISTS "public_insert_contact_messages" ON contact_messages;
CREATE POLICY "public_insert_contact_messages" ON contact_messages
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
