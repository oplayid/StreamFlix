// The installed @tanstack/react-router and @tanstack/react-start resolve two
// different copies of @tanstack/router-core. The Start package augments its own
// (nested) copy, so route files using the top-level react-router copy never see
// the `server` option. Re-apply the augmentation against the copy our routes use.
import type { RouteServerOptions } from "@tanstack/react-start";
import type { AnyContext, AnyRoute } from "@tanstack/router-core";

declare module "@tanstack/router-core" {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends AnyRoute = AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = AnyContext,
    TBeforeLoadFn = AnyContext,
    TRemountDepsFn = AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: RouteServerOptions<
      TRegister,
      TParentRoute,
      TPath,
      TParams,
      TLoaderDeps,
      TLoaderFn,
      TRouterContext,
      TRouteContextFn,
      TBeforeLoadFn,
      TServerMiddlewares,
      THandlers
    >;
  }
}
