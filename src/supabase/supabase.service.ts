import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

export function supabaseConfig() {
  return {
    url: process.env.SUPABASE_URL ?? '',
    key: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  };
}

/**
 * Crea un cliente de Supabase por petición con el JWT del usuario:
 * las políticas RLS garantizan que cada usuario solo accede a sus datos.
 */
@Injectable()
export class SupabaseService {
  forRequest(authorization?: string): { client: SupabaseClient; token: string } {
    const { url, key } = supabaseConfig();
    if (!url || !key) throw new ServiceUnavailableException('Supabase no está configurado (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY).');
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Inicia sesión para sincronizar tus proyectos.');
    const client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return { client, token };
  }

  async user(authorization?: string) {
    const { client, token } = this.forRequest(authorization);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException('Sesión inválida o expirada. Vuelve a iniciar sesión.');
    return { client, user: data.user };
  }
}
