import { type CanActivate, Injectable, SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "auth:public";

export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
