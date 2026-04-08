/**
 * MarketplaceContext — unified data layer for the marketplace modal.
 *
 * Fetches both skills/index.json and themes/index.json on mount,
 * loads package state from destincode-skills.json, and exposes
 * install/uninstall methods that work for any content type.
 *
 * Does NOT replace SkillContext (command drawer) or ThemeContext (DOM theming).
 * This context is only mounted when the marketplace modal is open.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { SkillEntry, ChipConfig } from '../../shared/types';
import type { ThemeRegistryEntryWithStatus } from '../../shared/theme-marketplace-types';

// window.claude is typed for skills but not for theme.marketplace — cast via any
const claude = () => (window as any).claude;

// ── Types ────────────────────────────────────────────────────────────────────

export type MarketplaceTab = 'installed' | 'skills' | 'themes';

export interface MarketplaceEntry {
  id: string;
  type: 'plugin' | 'prompt' | 'theme';
  displayName: string;
  description: string;
  category?: string;
  author?: string;
  version?: string;
  source?: string; // marketplace, user, external
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: boolean;
}

interface MarketplaceState {
  // Raw index data
  skillEntries: SkillEntry[];
  themeEntries: ThemeRegistryEntryWithStatus[];
  // Package tracking from config (populated in Phase 3)
  packages: Record<string, any>;
  // Installed content (merged from all sources)
  installedSkills: SkillEntry[];
  // User content
  privateSkills: SkillEntry[];
  chips: ChipConfig[];
  favorites: string[];
  // Loading/error state
  loading: boolean;
  error: string | null;
}

interface MarketplaceActions {
  // Install/uninstall for any content type
  installSkill: (id: string) => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  installTheme: (slug: string) => Promise<void>;
  uninstallTheme: (slug: string) => Promise<void>;
  // Favorites & chips
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  setChips: (chips: ChipConfig[]) => Promise<void>;
  // Refresh data
  refresh: () => Promise<void>;
  // Prompt skill management
  createPrompt: (skill: Omit<SkillEntry, 'id'>) => Promise<SkillEntry>;
  deletePrompt: (id: string) => Promise<void>;
}

type MarketplaceContextValue = MarketplaceState & MarketplaceActions;

// ── Context ──────────────────────────────────────────────────────────────────

const MarketplaceContext = createContext<MarketplaceContextValue | null>(null);

export function useMarketplace(): MarketplaceContextValue {
  const ctx = useContext(MarketplaceContext);
  if (!ctx) throw new Error('useMarketplace must be used within MarketplaceProvider');
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function MarketplaceProvider({ children }: { children: React.ReactNode }) {
  const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
  const [themeEntries, setThemeEntries] = useState<ThemeRegistryEntryWithStatus[]>([]);
  const [packages, setPackages] = useState<Record<string, any>>({});
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([]);
  const [privateSkills, setPrivateSkills] = useState<SkillEntry[]>([]);
  const [chips, setChipsState] = useState<ChipConfig[]>([]);
  const [favorites, setFavoritesState] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all marketplace data in parallel on mount
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        marketplaceSkills,
        themes,
        installed,
        favs,
        chipList,
      ] = await Promise.all([
        window.claude.skills.listMarketplace(),
        claude().theme.marketplace.list().catch(() => []),
        window.claude.skills.list(),
        window.claude.skills.getFavorites(),
        window.claude.skills.getChips(),
      ]);

      setSkillEntries(marketplaceSkills || []);
      setThemeEntries(themes || []);
      setInstalledSkills(installed || []);
      setFavoritesState(favs || []);
      setChipsState(chipList || []);

      // Extract private skills from installed list
      const priv = (installed || []).filter((s: SkillEntry) =>
        s.visibility === 'private' || s.source === 'self'
      );
      setPrivateSkills(priv);
    } catch (err: any) {
      setError(err?.message || 'Failed to load marketplace data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const installSkill = useCallback(async (id: string) => {
    await window.claude.skills.install(id);
    await fetchAll(); // Refresh all state after install
  }, [fetchAll]);

  const uninstallSkill = useCallback(async (id: string) => {
    await window.claude.skills.uninstall(id);
    await fetchAll();
  }, [fetchAll]);

  const installTheme = useCallback(async (slug: string) => {
    await claude().theme.marketplace.install(slug);
    await fetchAll();
  }, [fetchAll]);

  const uninstallTheme = useCallback(async (slug: string) => {
    await claude().theme.marketplace.uninstall(slug);
    await fetchAll();
  }, [fetchAll]);

  const setFavorite = useCallback(async (id: string, favorited: boolean) => {
    await window.claude.skills.setFavorite(id, favorited);
    // Optimistic update
    setFavoritesState(prev =>
      favorited ? [...prev, id] : prev.filter(f => f !== id)
    );
  }, []);

  const setChips = useCallback(async (newChips: ChipConfig[]) => {
    await window.claude.skills.setChips(newChips);
    setChipsState(newChips);
  }, []);

  const createPrompt = useCallback(async (skill: Omit<SkillEntry, 'id'>) => {
    const result = await window.claude.skills.createPrompt(skill);
    await fetchAll();
    return result;
  }, [fetchAll]);

  const deletePrompt = useCallback(async (id: string) => {
    await window.claude.skills.deletePrompt(id);
    await fetchAll();
  }, [fetchAll]);

  // ── Memoized value ───────────────────────────────────────────────────────

  const value = useMemo<MarketplaceContextValue>(() => ({
    skillEntries,
    themeEntries,
    packages,
    installedSkills,
    privateSkills,
    chips,
    favorites,
    loading,
    error,
    installSkill,
    uninstallSkill,
    installTheme,
    uninstallTheme,
    setFavorite,
    setChips,
    refresh: fetchAll,
    createPrompt,
    deletePrompt,
  }), [
    skillEntries, themeEntries, packages, installedSkills, privateSkills,
    chips, favorites, loading, error,
    installSkill, uninstallSkill, installTheme, uninstallTheme,
    setFavorite, setChips, fetchAll, createPrompt, deletePrompt,
  ]);

  return (
    <MarketplaceContext.Provider value={value}>
      {children}
    </MarketplaceContext.Provider>
  );
}
