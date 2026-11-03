export interface JwtPayload {
  sub: string;
  email: string;
  isSysadmin: boolean;
  /** User.tokenVersion when the token was issued; missing on tokens from before SDI-133, read as 0. */
  ver?: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  isSysadmin: boolean;
}
