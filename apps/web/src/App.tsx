import type { ReactNode } from "react";
import { Routes, Route } from "react-router-dom";
import { LoginPage } from "@/features/auth/LoginPage";
import { HomePage } from "@/features/home/HomePage";
import { ProtectedRoute } from "@/features/auth/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import { ClientsListPage } from "@/features/masters/clients/ClientsListPage";
import { ClientFormPage } from "@/features/masters/clients/ClientFormPage";

function Protected({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <HomePage />
          </Protected>
        }
      />
      <Route
        path="/masters/clients"
        element={
          <Protected>
            <ClientsListPage />
          </Protected>
        }
      />
      <Route
        path="/masters/clients/new"
        element={
          <Protected>
            <ClientFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/clients/:id"
        element={
          <Protected>
            <ClientFormPage />
          </Protected>
        }
      />
    </Routes>
  );
}
