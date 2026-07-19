import type { ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Role } from "@svyft/shared";
import { LoginPage } from "@/features/auth/LoginPage";
import { HomePage } from "@/features/home/HomePage";
import { ProtectedRoute } from "@/features/auth/ProtectedRoute";
import { useAuth } from "@/features/auth/AuthProvider";
import { AppLayout } from "@/components/AppLayout";
import { ClientsListPage } from "@/features/masters/clients/ClientsListPage";
import { ClientFormPage } from "@/features/masters/clients/ClientFormPage";
import { VesselsListPage } from "@/features/masters/vessels/VesselsListPage";
import { VesselFormPage } from "@/features/masters/vessels/VesselFormPage";
import { ConfigPage } from "@/features/admin/ConfigPage";
import { QueriesListPage } from "@/features/query-list/QueriesListPage";

function Protected({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <AppLayout>{children}</AppLayout>
    </ProtectedRoute>
  );
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.role === Role.ADMINISTRATOR ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/queries" replace />} />
      <Route
        path="/queries"
        element={
          <Protected>
            <QueriesListPage />
          </Protected>
        }
      />
      <Route
        path="/queries/new"
        element={
          <Protected>
            <div>Create Query (Task 5)</div>
          </Protected>
        }
      />
      <Route
        path="/queries/:id"
        element={
          <Protected>
            <div>Query Detail (Task 5)</div>
          </Protected>
        }
      />
      <Route
        path="/home"
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
      <Route
        path="/masters/vessels"
        element={
          <Protected>
            <VesselsListPage />
          </Protected>
        }
      />
      <Route
        path="/masters/vessels/new"
        element={
          <Protected>
            <VesselFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/vessels/:id"
        element={
          <Protected>
            <VesselFormPage />
          </Protected>
        }
      />
      <Route
        path="/admin/config"
        element={
          <Protected>
            <AdminOnly>
              <ConfigPage />
            </AdminOnly>
          </Protected>
        }
      />
    </Routes>
  );
}
