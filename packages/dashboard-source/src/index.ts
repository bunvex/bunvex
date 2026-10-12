// Package @bunvex/dashboard-source — the dashboard's data source for a bunvex deployment (STUDY-149): the
// `DashboardDataSource` contract of @bunvex/dashboard over the admin key, one sync connection
// (@bunvex/client) and the admin HTTP routes, as Convex's dashboard reads a deployment; and the sign-in's
// `check_admin_key` verifier. The dashboard package itself stays free of any bunvex dependency (UI-01 §6).
export { adminHeaders, CLIENT_NAME } from "./admin-http.ts";
export {
  type AdminCredentials,
  type AdminKeyCheck,
  type AdminKeyVerifier,
  type AdminKeyVerifierOptions,
  capabilitiesOf,
  createAdminKeyVerifier,
  INVALID_CREDENTIALS,
  SERVER_OPS,
} from "./credentials.ts";
export { createServerDataSource, type ServerDataSource, type ServerDataSourceOptions } from "./server-source.ts";
export { CONNECTION_CHECK_MS, type ConnectionStatus } from "./sync.ts";
