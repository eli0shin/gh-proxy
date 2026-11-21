export type RawActor = { readonly __typename: string; readonly login?: string | null };

export type Actor = { readonly login: string; readonly type: string; readonly isBot: boolean };

// GraphQL drops the `[bot]` suffix REST puts on bot logins. Restore it, so
// logins match those from REST and the gh commands consumers used before.
export function actor(raw: RawActor | null | undefined): Actor | null {
  if (!raw?.login) return null;
  const isBot = raw.__typename === 'Bot';
  const login = isBot && !raw.login.endsWith('[bot]') ? `${raw.login}[bot]` : raw.login;
  return { login, type: raw.__typename, isBot };
}
