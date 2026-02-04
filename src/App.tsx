import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { OrganizationProvider } from "@/contexts/OrganizationContext";
import "@/i18n";
import Favicon from "@/components/Favicon";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import ProjectDetails from "./pages/ProjectDetails";
import QuickGuide from "./pages/QuickGuide";
import GlobalChat from "./pages/GlobalChat";
import Documentation from "./pages/Documentation";
import Admin from "./pages/Admin";
import AdminOrgUsers from "./pages/AdminOrgUsers";
import AdminAnalytics from "./pages/AdminAnalytics";
import OrgSettings from "./pages/OrgSettings";
import NotFound from "./pages/NotFound";
import ProtectedRoute from "./components/ProtectedRoute";
import WizardContainer from "./components/wizard/WizardContainer";

// App mode (mobile-first executive experience)
import { 
  AppSplash,
  AppLogin,
  AppOnboarding,
  AppHome,
  AppProjects,
  AppProject,
  AppImpact,
  AppLys,
  AppSettings,
  AppDocs,
  AppQuickGuide
} from "./pages/app";

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Favicon />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <OrganizationProvider>
            <Routes>
              {/* ========================================
                  WEB MODE - Desktop/Full Experience
                  ======================================== */}
              
              {/* Landing page (marketing) */}
              <Route path="/" element={<Landing />} />
            
            {/* Auth */}
            <Route path="/auth" element={<Auth />} />
            
            {/* Main Dashboard */}
            <Route 
              path="/dashboard" 
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              } 
            />
            
            {/* Quick Guide */}
            <Route 
              path="/guia-rapido" 
              element={
                <ProtectedRoute>
                  <QuickGuide />
                </ProtectedRoute>
              } 
            />
            
            {/* Global Chat */}
            <Route 
              path="/chatbot" 
              element={
                <ProtectedRoute>
                  <GlobalChat />
                </ProtectedRoute>
              } 
            />
            
            {/* Documentation */}
            <Route 
              path="/documentacao" 
              element={
                <ProtectedRoute>
                  <Documentation />
                </ProtectedRoute>
              } 
            />
            
            {/* Admin */}
            <Route 
              path="/admin" 
              element={
                <ProtectedRoute>
                  <Admin />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/admin/org/:orgId/users" 
              element={
                <ProtectedRoute>
                  <AdminOrgUsers />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/admin/analytics" 
              element={
                <ProtectedRoute>
                  <AdminAnalytics />
                </ProtectedRoute>
              } 
            />
            
            {/* Org Settings */}
            <Route 
              path="/org/settings" 
              element={
                <ProtectedRoute>
                  <OrgSettings />
                </ProtectedRoute>
              } 
            />
            
            {/* Project Wizard */}
            <Route 
              path="/projeto/novo/wizard" 
              element={
                <ProtectedRoute>
                  <WizardContainer />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/projeto/:projectId/wizard" 
              element={
                <ProtectedRoute>
                  <WizardContainer />
                </ProtectedRoute>
              } 
            />
            
            {/* Project Details */}
            <Route 
              path="/projeto/:projectId" 
              element={
                <ProtectedRoute>
                  <ProjectDetails />
                </ProtectedRoute>
              } 
            />

            {/* ========================================
                APP MODE - Mobile-First / PWA Experience
                ======================================== */}
            
            {/* App Entry Point (Splash Screen) */}
            <Route path="/app" element={<AppSplash />} />
            
            {/* App Login (dedicated, not using web /auth) */}
            <Route path="/app/login" element={<AppLogin />} />
            
            {/* App Onboarding - No auth required (shown before login) */}
            <Route path="/app/bem-vindo" element={<AppOnboarding />} />
            
            {/* App Home */}
            <Route 
              path="/app/home" 
              element={
                <ProtectedRoute>
                  <AppHome />
                </ProtectedRoute>
              } 
            />
            
            {/* App Projects List */}
            <Route 
              path="/app/projetos" 
              element={
                <ProtectedRoute>
                  <AppProjects />
                </ProtectedRoute>
              } 
            />
            
            {/* App Project Detail */}
            <Route 
              path="/app/projeto/:projectId" 
              element={
                <ProtectedRoute>
                  <AppProject />
                </ProtectedRoute>
              } 
            />
            
            {/* App Impact Overview */}
            <Route 
              path="/app/impacto" 
              element={
                <ProtectedRoute>
                  <AppImpact />
                </ProtectedRoute>
              } 
            />
            
            {/* App Lys Chat */}
            <Route 
              path="/app/lys" 
              element={
                <ProtectedRoute>
                  <AppLys />
                </ProtectedRoute>
              } 
            />
            
            {/* App Settings */}
            <Route 
              path="/app/settings" 
              element={
                <ProtectedRoute>
                  <AppSettings />
                </ProtectedRoute>
              } 
            />
            
            {/* App Docs */}
            <Route 
              path="/app/docs" 
              element={
                <ProtectedRoute>
                  <AppDocs />
                </ProtectedRoute>
              } 
            />
            
            {/* App Quick Guide */}
            <Route 
              path="/app/guia-rapido" 
              element={
                <ProtectedRoute>
                  <AppQuickGuide />
                </ProtectedRoute>
              } 
            />

            {/* ========================================
                LEGACY REDIRECTS (old /executivo routes)
                ======================================== */}
            <Route path="/executivo" element={<Navigate to="/app/home" replace />} />
            <Route path="/executivo/projetos" element={<Navigate to="/app/projetos" replace />} />
            <Route path="/executivo/projeto/:projectId" element={<Navigate to="/app/projeto/:projectId" replace />} />
            <Route path="/executivo/impacto" element={<Navigate to="/app/impacto" replace />} />
            <Route path="/bem-vindo" element={<Navigate to="/app/bem-vindo" replace />} />
            
            {/* Catch-all */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </OrganizationProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ThemeProvider>
);

export default App;
