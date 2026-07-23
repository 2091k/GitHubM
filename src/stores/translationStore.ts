import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TranslateLang } from '@/lib/api/translation';

interface TranslationState {
  targetLang: TranslateLang | 'off';
  setTargetLang: (lang: TranslateLang | 'off') => void;
}

export const useTranslationStore = create<TranslationState>()(
  persist(
    (set) => ({
      targetLang: 'off',
      setTargetLang: (lang) => set({ targetLang: lang }),
    }),
    {
      name: 'githubm-translation-settings',
    }
  )
);
