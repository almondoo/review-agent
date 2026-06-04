import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/auth-context.js';

/**
 * ProtectedRoute is a router layout element.
 * Renders `<Outlet />` for authenticated or legacy-mode users.
 * Redirects unauthenticated users in session mode to /login.
 *
 * The mock/legacy bypass is handled at the AuthContext level (AuthProvider
 * sets legacy:true when IS_MOCK=true or when /me returns legacy:true).
 */
export function ProtectedRoute() {
  const { authenticated, legacy } = useAuth();

  // Legacy mode (shared token or mock) bypasses auth.
  if (legacy) {
    return <Outlet />;
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
