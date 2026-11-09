import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Hero } from '@/components/Hero';
import { PlatformOverview } from '@/components/PlatformOverview';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { AboutPage } from '@/pages/AboutPage';
import { ContactPage } from '@/pages/ContactPage';
import { TermsPage } from '@/pages/TermsPage';

function Layout() {
  const { pathname } = useLocation();
  const isHome = pathname === '/';

  return (
    <>
      <SiteHeader variant={isHome ? 'overlay' : 'solid'} />
      <main className="bg-midnight text-ivory">
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Hero />
                <PlatformOverview />
              </>
            }
          />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/contact" element={<ContactPage />} />
        </Routes>
      </main>
      <SiteFooter />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}

export default App;
