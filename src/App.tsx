import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
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
import { 
  ExecutiveHome, 
  ExecutiveProject, 
  SplashScreen, 
  Onboarding,
  ProjectsList,
  ImpactOverview
} from "./pages/executive";

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
            {/* Splash Screen - Entry point */}
            <Route path="/" element={<SplashScreen />} />
            
            {/* Onboarding */}
            <Route 
              path="/bem-vindo" 
              element={
                <ProtectedRoute>
                  <Onboarding />
                </ProtectedRoute>
              } 
            />
            
            {/* Landing page for marketing */}
            <Route path="/home" element={<Landing />} />
            
            {/* Auth */}
            <Route path="/auth" element={<Auth />} />
            
            <Route 
              path="/dashboard" 
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/guia-rapido" 
              element={
                <ProtectedRoute>
                  <QuickGuide />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/chatbot" 
              element={
                <ProtectedRoute>
                  <GlobalChat />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/documentacao" 
              element={
                <ProtectedRoute>
                  <Documentation />
                </ProtectedRoute>
              } 
            />
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
            <Route 
              path="/org/settings" 
              element={
                <ProtectedRoute>
                  <OrgSettings />
                </ProtectedRoute>
              } 
            />
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
            <Route 
              path="/projeto/:projectId" 
              element={
                <ProtectedRoute>
                  <ProjectDetails />
                </ProtectedRoute>
              } 
            />
            {/* Executive App (Mobile-First) */}
            <Route 
              path="/executivo" 
              element={
                <ProtectedRoute>
                  <ExecutiveHome />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/executivo/projetos" 
              element={
                <ProtectedRoute>
                  <ProjectsList />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/executivo/projeto/:projectId" 
              element={
                <ProtectedRoute>
                  <ExecutiveProject />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/executivo/impacto" 
              element={
                <ProtectedRoute>
                  <ImpactOverview />
                </ProtectedRoute>
              } 
            />
            
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
