import type { ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Role } from "@svyft/shared";
import { LoginPage } from "@/features/auth/LoginPage";
import { HomePage } from "@/features/home/HomePage";
import { ProtectedRoute } from "@/features/auth/ProtectedRoute";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { AppLayout } from "@/components/AppLayout";
import { ClientsListPage } from "@/features/masters/clients/ClientsListPage";
import { ClientFormPage } from "@/features/masters/clients/ClientFormPage";
import { VesselsListPage } from "@/features/masters/vessels/VesselsListPage";
import { VesselFormPage } from "@/features/masters/vessels/VesselFormPage";
import { FreightForwardersListPage } from "@/features/masters/freight-forwarders/FreightForwardersListPage";
import { FreightForwarderFormPage } from "@/features/masters/freight-forwarders/FreightForwarderFormPage";
import { FxRatesPage } from "@/features/masters/fx-rates/FxRatesPage";
import { WarehousesListPage } from "@/features/masters/warehouses/WarehousesListPage";
import { WarehouseFormPage } from "@/features/masters/warehouses/WarehouseFormPage";
import { ChargeCatalogueListPage } from "@/features/masters/charge-catalogue/ChargeCatalogueListPage";
import { ChargeLineFormPage } from "@/features/masters/charge-catalogue/ChargeLineFormPage";
import { ConfigPage } from "@/features/admin/ConfigPage";
import { QueriesListPage } from "@/features/query-list/QueriesListPage";
import { QueryWizardPage } from "@/features/query-wizard/QueryWizardPage";
import { QueryWorkspaceHub } from "@/features/rfq-workspace/QueryWorkspaceHub";
import { CompareQuotesPage } from "@/features/compare/CompareQuotesPage";
import { QuotationPage } from "@/features/quotation/QuotationPage";
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

// Administrator OR Manager (not Administrator-only like AdminOnly above) — the gate every
// master-data write endpoint enforces, and the one GET /api/charge-line-definitions/admin
// enforces too. Without it an Executive reaches a route whose only data source, or whose only
// action, can do nothing but 403. The list screens are deliberately NOT behind this: their GETs
// are open to any signed-in user, and hiding the "New" link is the right treatment there. The
// *form* routes are, because a row link on an open list page is an ungated way into a form whose
// every Save 403s.
function AdminOrManagerOnly({ children }: { children: ReactNode }) {
  return useCanWrite() ? <>{children}</> : <Navigate to="/" replace />;
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
        path="/queries/:id/compare"
        element={
          <Protected>
            <CompareQuotesPage />
          </Protected>
        }
      />
      <Route
        path="/queries/:id/quotation"
        element={
          <Protected>
            <QuotationPage />
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
            <AdminOrManagerOnly>
              <ClientFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/clients/:id"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <ClientFormPage />
            </AdminOrManagerOnly>
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
            <AdminOrManagerOnly>
              <VesselFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/vessels/:id"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <VesselFormPage />
            </AdminOrManagerOnly>
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
            <AdminOrManagerOnly>
              <FreightForwarderFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/freight-forwarders/:id"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <FreightForwarderFormPage />
            </AdminOrManagerOnly>
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
            <AdminOrManagerOnly>
              <WarehouseFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/warehouses/:id"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <WarehouseFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <ChargeCatalogueListPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue/new"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <ChargeLineFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/charge-catalogue/:id"
        element={
          <Protected>
            <AdminOrManagerOnly>
              <ChargeLineFormPage />
            </AdminOrManagerOnly>
          </Protected>
        }
      />
      <Route
        path="/masters/fx-rates"
        element={
          <Protected>
            <FxRatesPage />
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
