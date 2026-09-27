import { createContext, useContext, type ReactNode } from 'react';

export interface AdminParentRoute {
  path: string;
  label: string;
  labelKey?: string;
}

const AdminRouteContext = createContext<AdminParentRoute | null>(null);

export function AdminRouteProvider({ parent, children }: { parent: AdminParentRoute | null; children: ReactNode }): JSX.Element {
  return <AdminRouteContext.Provider value={parent}>{children}</AdminRouteContext.Provider>;
}

export function useAdminParentRoute(): AdminParentRoute | null {
  return useContext(AdminRouteContext);
}
