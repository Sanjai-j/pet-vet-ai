import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from './auth.service';
import { Role } from './models';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.token()) return true;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/**
 * Role guards may run before the profile request resolves on a full page load,
 * so wait for it instead of bouncing the user away from the route they opened.
 */
export const roleGuard = (roles: Role[]): CanActivateFn => () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.token()) return router.createUrlTree(['/login']);

  const decide = (role: Role | undefined) =>
    role && roles.includes(role) ? true : router.createUrlTree(['/dashboard']);

  const user = auth.user();
  if (user) return decide(user.role);

  return auth.refresh().pipe(
    map((res) => decide(res.user.role)),
    catchError(() => {
      auth.clearSession();
      return of(router.createUrlTree(['/login']));
    }),
  );
};
