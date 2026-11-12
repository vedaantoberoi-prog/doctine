import { LegalPage, LegalSection } from '@/components/LegalPage';

export function TermsPage() {
  return (
    <LegalPage eyebrow="Legal" title="Terms of service" intro="Last updated 5 November 2026">
      <div className="rounded-2xl border border-champagne/60 bg-white p-6 text-base leading-[1.5]">
        <p className="font-medium text-midnight">Doctine is not a doctor and is not for emergencies.</p>
        <p className="mt-3 text-midnight/80">
          It gives general health information and helps you keep your records. It does not diagnose, treat or
          prescribe. In a medical emergency, call <strong className="font-medium text-midnight">112</strong>. For
          mental-health support, call Tele-MANAS on <strong className="font-medium text-midnight">14416</strong>.
        </p>
      </div>

      <LegalSection heading="About these terms">
        <p>
          These terms are an agreement between you and Doctine Private Limited, India (&ldquo;Doctine&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;). They cover the Doctine app at app.doctine.com, this website and the app
          preview. By creating an account or using Doctine, you agree to them. Our privacy policy explains how we handle
          your data.
        </p>
      </LegalSection>

      <LegalSection heading="What Doctine does">
        <p>
          Doctine lets you store and organise your health records, keep track of medicines and doses, and keep a health
          profile. An AI assistant that answers health questions in plain language and reads the details from scanned
          documents is being developed; these features are not switched on yet, and these terms apply to them when they
          are.
        </p>
      </LegalSection>

      <LegalSection heading="Who can use Doctine">
        <p>
          You must be 18 or older and able to agree to these terms. A parent or legal guardian may keep a child's
          records in their own account.
        </p>
      </LegalSection>

      <LegalSection heading="Your content">
        <p>
          The records, documents and other information you add are yours. You give us permission to store, process and
          display them, and to send them to our service providers as described in the privacy policy, only so we can
          provide Doctine to you. You can export or delete your content at any time in Settings.
        </p>
      </LegalSection>

      <LegalSection heading="Availability and changes">
        <p>
          Doctine is new and still being developed. Features may change, and the service may sometimes be unavailable.
          Keep your own copies of important records; you can export yours at any time. If we change these terms in an
          important way, we will tell you in the app before the change applies. If you keep using Doctine after that,
          you accept the new terms.
        </p>
      </LegalSection>

      <LegalSection heading="Fees">
        <p>
          Doctine is free to use at the moment. If we introduce paid features, we will tell you the price before you are
          charged.
        </p>
      </LegalSection>

      <LegalSection heading="Ending your use">
        <p>
          You can stop using Doctine and delete your account at any time in Settings, under &ldquo;Delete my account and
          data&rdquo;.
        </p>
      </LegalSection>

      <LegalSection heading="Responsibility">
        <p>
          We work to keep Doctine accurate, secure and available, but we provide it &ldquo;as is&rdquo;. To the extent
          the law allows, we are not responsible for decisions you make based on information from Doctine, or for
          indirect losses. Nothing in these terms limits rights you have under Indian law, including consumer protection
          law, that cannot be limited by agreement.
        </p>
      </LegalSection>

      <LegalSection heading="Law and disputes">
        <p>
          These terms are governed by the laws of India. If you have a problem, please contact us first so we can try to
          fix it. Otherwise, disputes go to the courts of India.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>Doctine Private Limited, India.</p>
      </LegalSection>
    </LegalPage>
  );
}
