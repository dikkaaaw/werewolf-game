"use client";

import { useEffect, useState, createContext, ReactNode, useContext, useMemo } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

export type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  supabase: ReturnType<typeof createClient>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        console.error('Auth getSession error:', error.message);
        setLoading(false);
      } else if (data.session) {
        setSession(data.session);
        setUser(data.session.user);
        setLoading(false);
      } else {
        supabase.auth.signInAnonymously().then(({ data: signInData, error: signInError }) => {
          if (!mounted) return;
          if (signInError) {
            console.error('Anonymous sign-in error:', signInError.message);
          } else if (signInData.session) {
            setSession(signInData.session);
            setUser(signInData.session.user);
          }
          setLoading(false);
        }).catch((err) => {
          if (mounted) {
            console.error('Anonymous sign-in exception:', err);
            setLoading(false);
          }
        });
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, currentSession) => {
      if (!mounted) return;
      setSession(currentSession);
      setUser(currentSession?.user ?? null);
      setLoading(false);
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && currentSession?.access_token) {
        supabase.realtime.setAuth(currentSession.access_token);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const signIn = async () => {
    setLoading(true);
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
      console.error('Sign-in error:', error.message);
    } else if (data.session) {
      setSession(data.session);
      setUser(data.session.user);
    }
    setLoading(false);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, supabase, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const result = useContext(AuthContext);
  if (!result) throw new Error('useAuth must be used within an AuthProvider');
  return result;
}
