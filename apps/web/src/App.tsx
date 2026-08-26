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
import { FreightForwardersListPage } from "@/features/masters/freight-forwarders/FreightForwardersListPage";
import { FreightForwarderFormPage } from "@/features/masters/freight-forwarders/FreightForwarderFormPage";
import { WarehousesListPage } from "@/features/masters/warehouses/WarehousesListPage";
import { WarehouseFormPage } from "@/features/masters/warehouses/WarehouseFormPage";
import { ChargeCatalogueListPage } from "@/features/masters/charge-catalogue/ChargeCatalogueListPage";
import { ChargeLineFormPage } from "@/features/masters/charge-catalogue/ChargeLineFormPage";
import { ConfigPage } from "@/features/admin/ConfigPage";
import { QueriesListPage } from "@/features/query-list/QueriesListPage";
import { QueryWizardPage } from "@/features/query-wizard/QueryWizardPage";
import { QueryWorkspaceHub } from "@/features/rfq-workspace/QueryWorkspaceHub";
import { FfPortalPage } from "@/features/ff-portal/FfPortalPage";

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
      <Route path="/ff/rfq/:token" element={<FfPortalPage />} />
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
            <QueryWizardPage />
          </Protected>
        }
      />
      <Route
        path="/queries/:id/workspace"
        element={
          <Protected>
            <QueryWorkspaceHub />
          </Protected>
        }
      />
      <Route
        path="/queries/:id"
        element={
          <Protected>
            <QueryWizardPage />
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
        path="/masters/freight-forwarders"
        element={
          <Protected>
            <FreightForwardersListPage />
          </Protected>
        }
      />
      <Route
        path="/masters/freight-forwarders/new"
        element={
          <Protected>
            <FreightForwarderFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/freight-forwarders/:id"
        element={
          <Protected>
            <FreightForwarderFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/warehouses"
        element={
          <Protected>
            <WarehousesListPage />
          </Protected>
        }
      />
      <Route
        path="/masters/warehouses/new"
        element={
          <Protected>
            <WarehouseFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/warehouses/:id"
        element={
          <Protected>
            <WarehouseFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue"
        element={
          <Protected>
            <ChargeCatalogueListPage />
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue/new"
        element={
          <Protected>
            <ChargeLineFormPage />
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue/:id"
        element={
          <Protected>
            <ChargeLineFormPage />
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
