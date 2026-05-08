export type EnvReader = {
  get(name: string): string | undefined;
};

const denoEnv: EnvReader = {
  get(name: string) {
    return Deno.env.get(name);
  },
};

export function optionalEnv(name: string, aliases: string[] = [], env: EnvReader = denoEnv) {
  for (const key of [name, ...aliases]) {
    const value = env.get(key);

    if (value) {
      return value;
    }
  }

  return '';
}

export function requiredEnv(name: string, aliases: string[] = [], env: EnvReader = denoEnv) {
  const value = optionalEnv(name, aliases, env);

  if (!value) {
    throw new Error(`Missing required environment variable: ${[name, ...aliases].join(' or ')}`);
  }

  return value;
}

export function getSiteUrl(env: EnvReader = denoEnv) {
  return optionalEnv('ECOVILA_SITE_URL', ['SITE_URL'], env).replace(/\/+$/, '') ||
    'https://ecovila.md';
}
