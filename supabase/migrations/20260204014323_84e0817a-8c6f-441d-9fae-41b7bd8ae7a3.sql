-- Add onboarding_done column to profiles table for executive app onboarding
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN NOT NULL DEFAULT false;