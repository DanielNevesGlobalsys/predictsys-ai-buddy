import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { OrganizationProvider } from "@/contexts/OrganizationContext";
import "@/i18n";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import ProjectDetails from "./pages/ProjectDetails";
import QuickGuide from "./pages/QuickGuide";
import GlobalChat from "./pages/GlobalChat";
import Documentation from "./pages/Documentation";
import Admin from "./pages/Admin";
import AdminOrgUsers from "./pages/AdminOrgUsers";
import OrgSettings from "./pages/OrgSettings";
import NotFound from "./pages/NotFound";
import ProtectedRoute from "./components/ProtectedRoute";
import WizardContainer from "./components/wizard/WizardContainer";

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <OrganizationProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
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
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </OrganizationProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ThemeProvider>
);

export default App;
