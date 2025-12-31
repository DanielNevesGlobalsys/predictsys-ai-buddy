import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";

interface TranslationInput {
  [key: string]: string | null | undefined;
}

interface TranslationResult {
  translations: Record<string, string>;
  isTranslating: boolean;
  originalLanguage: string | null;
}

// Simple language detection based on common words
function detectLanguage(text: string): string {
  const ptWords = ["de", "do", "da", "para", "com", "em", "os", "as", "um", "uma", "que", "não", "cliente", "clientes", "projeto", "modelo", "prever", "previsão"];
  const esWords = ["de", "del", "para", "con", "en", "los", "las", "un", "una", "que", "no", "cliente", "clientes", "proyecto", "modelo", "predecir", "predicción"];
  const enWords = ["the", "of", "to", "and", "in", "for", "with", "that", "this", "customer", "customers", "project", "model", "predict", "prediction", "churn"];

  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/);

  let ptScore = 0;
  let esScore = 0;
  let enScore = 0;

  words.forEach(word => {
    if (ptWords.includes(word)) ptScore++;
    if (esWords.includes(word)) esScore++;
    if (enWords.includes(word)) enScore++;
  });

  // Portuguese-specific characters
  if (/[ãõç]/.test(lowerText)) ptScore += 3;
  // Spanish-specific
  if (/[ñ¿¡]/.test(lowerText)) esScore += 3;

  if (ptScore > esScore && ptScore > enScore) return "pt";
  if (esScore > ptScore && esScore > enScore) return "es";
  if (enScore > 0) return "en";
  
  // Default to Portuguese as most content was created in PT
  return "pt";
}

// Cache for translations
const translationCache: Record<string, Record<string, string>> = {};

function getCacheKey(texts: TranslationInput, targetLang: string): string {
  const sortedKeys = Object.keys(texts).sort();
  const values = sortedKeys.map(k => texts[k] || "").join("|");
  return `${targetLang}:${values}`;
}

export function useTranslateContent(
  content: TranslationInput,
  enabled: boolean = true
): TranslationResult {
  const { i18n } = useTranslation();
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const [originalLanguage, setOriginalLanguage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Return original content
      const original: Record<string, string> = {};
      Object.entries(content).forEach(([key, value]) => {
        if (value) original[key] = value;
      });
      setTranslations(original);
      return;
    }

    // Detect language from longest text field
    const allText = Object.values(content)
      .filter(Boolean)
      .join(" ");
    
    if (!allText.trim()) {
      setTranslations({});
      return;
    }

    const detectedLang = detectLanguage(allText);
    setOriginalLanguage(detectedLang);

    const currentLang = i18n.language.split("-")[0]; // "pt-BR" -> "pt"

    // If same language, no translation needed
    if (currentLang === detectedLang) {
      const original: Record<string, string> = {};
      Object.entries(content).forEach(([key, value]) => {
        if (value) original[key] = value;
      });
      setTranslations(original);
      return;
    }

    // Check cache
    const cacheKey = getCacheKey(content, currentLang);
    if (translationCache[cacheKey]) {
      setTranslations(translationCache[cacheKey]);
      return;
    }

    // Translate
    const translateContent = async () => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      setIsTranslating(true);
      try {
        const textsToTranslate = Object.entries(content)
          .filter(([_, value]) => value && value.trim())
          .map(([key, value]) => ({ key, value: value! }));

        if (textsToTranslate.length === 0) {
          setTranslations({});
          return;
        }

        const { data, error } = await supabase.functions.invoke("translate-content", {
          body: {
            texts: textsToTranslate,
            targetLanguage: currentLang,
            sourceLanguage: detectedLang,
          },
        });

        if (error) {
          console.error("Translation error:", error);
          // Fallback to original content
          const original: Record<string, string> = {};
          Object.entries(content).forEach(([key, value]) => {
            if (value) original[key] = value;
          });
          setTranslations(original);
          return;
        }

        if (data?.success && data?.translations) {
          // Cache the result
          translationCache[cacheKey] = data.translations;
          setTranslations(data.translations);
        } else {
          // Fallback to original content
          const original: Record<string, string> = {};
          Object.entries(content).forEach(([key, value]) => {
            if (value) original[key] = value;
          });
          setTranslations(original);
        }
      } catch (err) {
        console.error("Translation failed:", err);
        const original: Record<string, string> = {};
        Object.entries(content).forEach(([key, value]) => {
          if (value) original[key] = value;
        });
        setTranslations(original);
      } finally {
        setIsTranslating(false);
      }
    };

    // Debounce translation call
    const timeoutId = setTimeout(translateContent, 300);
    return () => clearTimeout(timeoutId);
  }, [content, i18n.language, enabled]);

  return { translations, isTranslating, originalLanguage };
}
